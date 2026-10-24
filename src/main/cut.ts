import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scope } from './logger.js'
import { ffmpegTo, probeClip, resolveFfmpeg } from './ffmpeg.js'
import { detectGpuEncoder, videoArgs, MIN_VIDEO_KBPS } from './export.js'
import { layout, type CutRange, type Item } from '@shared/cut.js'

const log = scope('Cut')

/** Audio bitrate for the re-encoded path. The editor's own re-encode uses the same. */
const AUDIO_KBPS = 160

/**
 * How long a demux-only pass may take (the keyframe scan, the copy check).
 *
 * Both read the file without decoding it, so they are quick on a clip and slow on an
 * hour-long recording on a slow or network drive. Giving up costs the fast path,
 * never correctness.
 */
const DEMUX_TIMEOUT_MS = 60_000

/**
 * How far a kept piece's start may sit past a keyframe and still be copied.
 *
 * An input-side seek lands on the keyframe at or before the point asked for, so
 * copying a start that is not on a keyframe brings back the frames in between --
 * the footage the user just asked to remove. Inside this tolerance that is a frame
 * or two at the head of a piece; past it the piece is re-encoded and the cut is exact.
 */
const KEYFRAME_TOLERANCE_SEC = 0.05

/**
 * How many frames short of its stated end a copied piece is asked to stop.
 *
 * A copy stops on a packet, not on a frame. H.264 codes B-frames after the frames
 * they predict from, so the packet carrying the stop can hold a frame from further
 * ahead than the one asked for: the piece then keeps a frame out of the removed part
 * and jumps over the ones before it. Stopping a couple of frames early usually puts
 * the stop before that packet. It costs up to two frames of kept footage at a seam,
 * and {@link copiedFramesRunEven} re-encodes the cut whenever it does not.
 */
const COPY_TAIL_PULLBACK_FRAMES = 2

/**
 * MP4 whatever the source container is.
 *
 * The concat demuxer wants one container, and `-c copy` into MP4 is free (it is a
 * remux): h264/aac -- what Rewind records -- needs no re-encode. It is also the
 * container the preview can play, which MKV is not (see editor.ts's remuxForPreview).
 */
const CUT_EXT = '.mp4'

/** Per-stream output volume; 1 keeps a stream untouched. */
export interface StreamVolume {
  stream: number
  volume: number
}

export interface WriteSequenceRequest {
  clipPath: string
  /** The edit, in output order: what the source keeps, and the gaps it holds. */
  items: Item[]
  /**
   * Where the joined result is written.
   *
   * The caller owns this path: it never covers the source, and a failed write is
   * the caller's to clean up.
   */
  out: string
  volumes?: StreamVolume[]
}

export interface WriteSequenceResult {
  durationSec: number
  removedSec: number
  pieces: number
  gaps: number
  reencoded: boolean
  bytes: number
}

/**
 * Keyframe timestamps of a file, in seconds, or null when they could not be read.
 *
 * One demux pass: `-skip_frame nokey` makes the decoder hand over keyframes only, so
 * every `pts_time` showinfo prints is a point a stream copy can land on. This is the
 * whole-file view, used by the cut test and for diagnostics; a save only needs the
 * keyframes around its cut points, which {@link canCopyFrom} reads with a short seek.
 *
 * A failure is null, never an empty list: no keyframes means a copy cannot be shown
 * to be exact, and the caller re-encodes rather than returning a cut that still
 * contains footage the user removed.
 */
export function probeKeyframes(file: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile(
      resolveFfmpeg(),
      ['-hide_banner', '-skip_frame', 'nokey', '-i', file, '-an', '-sn', '-vf', 'showinfo', '-f', 'null', '-'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: DEMUX_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        const times: number[] = []
        for (const m of String(stderr ?? '').matchAll(/pts_time:(-?[\d.]+)/g)) {
          const t = Number(m[1])
          if (Number.isFinite(t) && t >= 0) times.push(t)
        }
        if (!times.length) {
          const reason = err ? err.message.split(/\r?\n/).filter(Boolean).pop() : 'no keyframes reported'
          log.warn(`Could not read the keyframes of ${path.basename(file)} (${reason}); the cut will be re-encoded`)
          resolve(null)
          return
        }
        resolve(times)
      },
    )
  })
}

/**
 * True when a piece can start with a stream copy.
 *
 * The head of the clip is always a keyframe. Every other start needs one at or just
 * before it: `start - k >= 0` because the seek snaps back to `k`, and the tolerance
 * because a handle dragged to 12.51 should not force a re-encode of the whole clip.
 */
export function copyableStart(startSec: number, keyframes: number[]): boolean {
  if (startSec <= KEYFRAME_TOLERANCE_SEC) return true
  return keyframes.some((k) => startSec - k >= 0 && startSec - k <= KEYFRAME_TOLERANCE_SEC)
}

/**
 * Whether a copy can start at `startSec`, read with one short seek instead of a demux
 * of the whole file.
 *
 * `-ss` seeks to the keyframe at or before the tolerance window and discards up to
 * it, so the first keyframe `-skip_frame nokey` prints is the first one at or after
 * `start - tolerance`; `-copyts` keeps that time in the clip's own timeline. Feeding
 * that one timestamp to {@link copyableStart} asks the same question the full scan
 * answers, about the only keyframe that can decide it.
 *
 * A failed probe answers false, which re-encodes: a wrong yes would keep footage the
 * user removed, while a wrong no only costs time.
 */
async function canCopyFrom(file: string, startSec: number): Promise<boolean> {
  if (startSec <= KEYFRAME_TOLERANCE_SEC) return true
  return new Promise((resolve) => {
    execFile(
      resolveFfmpeg(),
      [
        '-hide_banner',
        '-ss', (startSec - KEYFRAME_TOLERANCE_SEC).toFixed(3),
        '-skip_frame', 'nokey', '-copyts', '-i', file,
        '-an', '-sn', '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-',
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: DEMUX_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        const m = /pts_time:(-?[\d.]+)/.exec(String(stderr ?? ''))
        const at = m ? Number(m[1]) : NaN
        if (err || !Number.isFinite(at)) {
          resolve(false)
          return
        }
        resolve(copyableStart(startSec, [at]))
      },
    )
  })
}

/**
 * Input side of one kept piece: seek, then read only as much as the piece needs.
 *
 * `-ss`/`-t` go BEFORE `-i` in both paths. Input-side, the seek lands on a keyframe
 * and the stream stays intact (an output-side seek produces files no player opens),
 * and with a re-encode it is still frame-accurate because ffmpeg discards what it
 * decoded past the cut point.
 */
function seekArgs(clipPath: string, seg: CutRange, lengthSec: number): string[] {
  return ['-ss', seg.startSec.toFixed(3), '-t', Math.max(0, lengthSec).toFixed(3), '-i', clipPath]
}

/** How much of a piece a copy should ask for, leaving the start untouched. */
function copyLengthSec(seg: CutRange, pullbackSec: number, clipSec: number): number {
  const length = seg.endSec - seg.startSec
  // The last piece ends where the clip does: pulling that back would drop the frames
  // at the end of the recording, which are kept rather than removed.
  if (seg.endSec >= clipSec - 0.02) return length
  return Math.max(0, length - pullbackSec)
}

export interface ProbeAudioInfo {
  streamCount: number
  split: boolean
  labels: string[]
}

/**
 * Decides how to address the clip's audio streams, and names them.
 *
 * More than one stream in the file means the recording split its tracks, whatever
 * the app's settings say now — a clip carries its own layout for life, and gating on
 * the live label count silently collapsed every multi-track clip into one mix the
 * moment the setting was turned off. Stream 0 is the mix the recorder always writes,
 * so it is dropped when the tracks are split. Labels come from the recording; a clip
 * with no recorded labels still splits, with generic names.
 */
export function analyzeAudio(info: ProbeAudioInfo): { split: boolean; streams: number[]; labels: string[] } {
  if (info.streamCount === 0) return { split: false, streams: [], labels: [] }
  if (!info.split) return { split: false, streams: [0], labels: ['Audio'] }
  const streams = Array.from({ length: info.streamCount - 1 }, (_, i) => i + 1)
  return { split: true, streams, labels: streams.map((s) => info.labels[s] ?? `Track ${s}`) }
}

/** A piece's audio graph: what to map, what to run, at which volumes. */
interface PieceAudio {
  filters: string[]
  maps: string[]
  codecs: string[]
}

/**
 * The audio for one copied piece, when track volumes were changed.
 *
 * The video stays a copy; only the audio is re-encoded. A clip whose tracks were
 * split has its mix stream rebuilt from the scaled lanes, so a saved file keeps the
 * layout it came in with: mix first, then one stream per track. With a single
 * stream there is nothing to rebuild and that stream is scaled.
 */
function pieceAudioArgs(
  probeInfo: ProbeAudioInfo,
  volumes: StreamVolume[],
): PieceAudio | null {
  if (probeInfo.streamCount === 0) return null
  const analysis = analyzeAudio(probeInfo)
  const volFor = (stream: number) => volumes.find((v) => v.stream === stream)?.volume ?? 1

  if (analysis.split) {
    const filters = analysis.streams.map((s) => `[0:a:${s}]volume=${volFor(s)},asplit=2[t${s}][m${s}]`)
    filters.push(`${analysis.streams.map((s) => `[m${s}]`).join('')}amix=inputs=${analysis.streams.length}:normalize=0[mix]`)
    return {
      filters,
      maps: ['-map', '0:v:0', '-map', '[mix]', ...analysis.streams.flatMap((s) => ['-map', `[t${s}]`])],
      codecs: ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`],
    }
  }

  // One stream: scaled. Any further streams (a layout the app does not make) pass
  // through untouched, which is what the editor did before it worked in pieces.
  const filters = [`[0:a:0]volume=${volFor(0)}[a0]`]
  const maps = ['-map', '0:v:0', '-map', '[a0]']
  const codecs = ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`]
  for (let s = 1; s < probeInfo.streamCount; s++) {
    maps.push('-map', `0:a:${s}`)
    codecs.push(`-c:a:${s}`, 'copy')
  }
  return { filters, maps, codecs }
}

/** One kept piece as a stream copy: no re-encode, so the frames are the source's. */
function copyArgs(
  clipPath: string,
  seg: CutRange,
  lengthSec: number,
  audio: PieceAudio | null,
  muxTail: string[],
): string[] {
  if (!audio) {
    return [
      ...seekArgs(clipPath, seg, lengthSec),
      // Without -map, ffmpeg keeps only the FIRST stream of each type, which is how a
      // three-track clip arrives with its Desktop and Microphone lanes missing.
      '-map', '0',
      '-c', 'copy',
      ...muxTail,
    ]
  }
  return [
    ...seekArgs(clipPath, seg, lengthSec),
    ...audio.maps,
    '-c:v', 'copy',
    ...audio.codecs,
    '-filter_complex', audio.filters.join(';'),
    ...muxTail,
  ]
}

/**
 * Every item in one ffmpeg run, re-encoded once and joined by the concat filter.
 *
 * Re-encoding is the price of two things a copy cannot express: a cut point between
 * keyframes, and a gap, which has no packets to copy at all. Joined in the filter
 * rather than as parts afterwards because parts from separate encodes each carry
 * their own parameter sets, and the concat demuxer plays them all under the first
 * part's. Here the frames never leave the encoder, so there is one stream, one
 * parameter set, and the audio is concatenated per stream in its original order --
 * which is what keeps the Desktop and Microphone lanes, and the lipsync, intact.
 *
 * A gap is its own generated input: black frames at the source's size and rate, and
 * silence. Holding it as real frames is what makes the output the length the user
 * sees on the timeline instead of the length of what was left.
 */
function concatFilterArgs(
  clipPath: string,
  items: Item[],
  probeInfo: ProbeAudioInfo,
  volumes: StreamVolume[],
  encoder: string | null,
  kbps: number,
  geometry: { width: number; height: number; fps: number },
  muxTail: string[],
): string[] {
  const analysis = analyzeAudio(probeInfo)
  const volFor = (stream: number) => volumes.find((v) => v.stream === stream)?.volume ?? 1
  const hasAudio = analysis.streams.length > 0
  const gapFps = geometry.fps > 0 ? geometry.fps : 30

  // Inputs, in sequence order. A kept piece is a seek into the clip; a gap is
  // generated. Each input's index is worth keeping: the chains below address them by
  // number, and a gap with audio takes two.
  const inputs: string[] = []
  const at: { item: Item; video: number; audio: number }[] = []
  let inputIndex = 0
  for (const item of items) {
    if (item.kind === 'keep') {
      inputs.push(...seekArgs(clipPath, { startSec: item.srcIn, endSec: item.srcOut }, item.srcOut - item.srcIn))
      at.push({ item, video: inputIndex, audio: inputIndex })
      inputIndex += 1
      continue
    }
    const durSec = Math.max(0, item.durSec).toFixed(3)
    inputs.push(
      '-t', durSec, '-f', 'lavfi', '-i',
      `color=c=black:s=${geometry.width}x${geometry.height}:r=${gapFps}`,
    )
    const video = inputIndex
    inputIndex += 1
    let audio = -1
    if (hasAudio) {
      inputs.push('-t', durSec, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
      audio = inputIndex
      inputIndex += 1
    }
    at.push({ item, video, audio })
  }

  const chains: string[] = []
  /** Per item, per stream: the label that feeds that stream's concat. */
  const streamOut: string[][] = []
  /** Per item: the label that feeds the rebuilt mix's concat (split clips only). */
  const mixOut: string[] = []

  items.forEach((item, i) => {
    const here = at[i]
    chains.push(
      item.kind === 'keep'
        ? `[${here.video}:v:0]setpts=PTS-STARTPTS[v${i}]`
        : `[${here.video}:v:0]format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    )
    if (!hasAudio) return
    if (item.kind === 'gap') {
      // One silence per lane plus one for the mix, cut apart before they are scaled.
      const labels = analysis.split
        ? [...analysis.streams.map((_, k) => `g${i}_${k}`), `gmix${i}`]
        : [`g${i}_0`]
      chains.push(`[${here.audio}:a:0]asplit=${labels.length}${labels.map((l) => `[${l}]`).join('')}`)
    }

    const perStream: string[] = []
    analysis.streams.forEach((stream, k) => {
      if (item.kind === 'keep') {
        const volume = volFor(stream)
        const scaled = volume === 1 ? '' : `volume=${volume},`
        if (analysis.split) {
          chains.push(`[${here.audio}:a:${stream}]${scaled}asetpts=PTS-STARTPTS,asplit=2[t${i}_${k}][m${i}_${k}]`)
          perStream.push(`t${i}_${k}`)
        } else {
          chains.push(`[${here.audio}:a:${stream}]${scaled}asetpts=PTS-STARTPTS[a${i}_${k}]`)
          perStream.push(`a${i}_${k}`)
        }
      } else {
        chains.push(`[g${i}_${k}]asetpts=PTS-STARTPTS[a${i}_${k}]`)
        perStream.push(`a${i}_${k}`)
      }
    })
    streamOut.push(perStream)

    if (analysis.split) {
      if (item.kind === 'keep') {
        chains.push(
          `${analysis.streams.map((_, k) => `[m${i}_${k}]`).join('')}amix=inputs=${analysis.streams.length}:normalize=0[mix${i}]`,
        )
        mixOut.push(`mix${i}`)
      } else {
        // A gap's mix is one of its own silence copies; no mix node needed.
        mixOut.push(`gmix${i}`)
      }
    }
  })

  // Rebased above, so each item starts at zero and the join has no gap to guess at.
  chains.push(`${items.map((_, i) => `[v${i}]`).join('')}concat=n=${items.length}:v=1:a=0[vout]`)
  const maps = ['-map', '[vout]']
  if (hasAudio) {
    analysis.streams.forEach((_, k) => {
      chains.push(
        `${streamOut.map((labels) => `[${labels[k]}]`).join('')}concat=n=${items.length}:v=0:a=1[aout${k}]`,
      )
    })
    if (analysis.split) {
      chains.push(`${mixOut.map((l) => `[${l}]`).join('')}concat=n=${items.length}:v=0:a=1[mixout]`)
      maps.push('-map', '[mixout]')
    }
    analysis.streams.forEach((_, k) => maps.push('-map', `[aout${k}]`))
  }

  return [
    ...inputs,
    '-filter_complex', chains.join(';'),
    ...maps,
    ...videoArgs(encoder, kbps),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`] : []),
    ...muxTail,
  ]
}

/**
 * True when a copy's frames run at a steady step, with no break in its own timeline.
 *
 * A copy stops on a packet, and with B-frames the packet that carries the stop can
 * hold a frame from further ahead than the one asked for: the piece then keeps a
 * frame out of the removed part and skips the ones before it. Demuxing only
 * (`-c copy` into framecrc) lists the frames' timestamps without decoding, so one
 * pass is enough to tell, and a cut that does not check out is re-encoded instead.
 *
 * A check that cannot run at all -- a timed-out pass on a network drive -- lets the
 * copy through: the cut is written and playable, and re-encoding it would cost the
 * user far more than the stray frame the check exists to catch.
 */
export function copiedFramesRunEven(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      resolveFfmpeg(),
      ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: DEMUX_TIMEOUT_MS },
      (err, stdout) => {
        // framecrc lists packets in decode order; a player shows them in presentation
        // order, and every B-frame reads as a break in the other.
        const times = String(stdout ?? '')
          .split(/\r?\n/)
          .map((line) => /^\d+,\s*-?\d+,\s*(-?\d+),/.exec(line))
          .flatMap((m) => (m ? [Number(m[1])] : []))
          .sort((a, b) => a - b)

        if (err || times.length < 3) {
          if (err) log.warn(`Could not check the copy's frame times (${err.message.split(/\r?\n/).pop()})`)
          resolve(true)
          return
        }

        const steps: number[] = []
        for (let i = 1; i < times.length; i++) steps.push(times[i] - times[i - 1])
        const even = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
        // A step of zero means two frames share a timestamp; that is a break too.
        resolve(even > 0 && steps.every((step) => step <= even * 1.5))
      },
    )
  })
}

/** Copies each kept piece to a scratch part, then joins the parts with the concat demuxer. */
async function concatCopies(
  clipPath: string,
  kept: CutRange[],
  scratchDir: string,
  out: string,
  pullbackSec: number,
  clipSec: number,
  audio: PieceAudio | null,
  muxTail: string[],
): Promise<boolean> {
  const parts: string[] = []
  let even = true
  for (let i = 0; i < kept.length; i++) {
    const part = path.join(scratchDir, `part-${String(i).padStart(3, '0')}${CUT_EXT}`)
    // No `+faststart`: a part is only ever read by the concat demuxer, and moving
    // the moov atom rewrites the whole part for a player that never sees it.
    await ffmpegTo(copyArgs(clipPath, kept[i], copyLengthSec(kept[i], pullbackSec, clipSec), audio, []), part)
    // Only a piece that stops short of the clip's end has a cut at its tail, and
    // only that tail can land on a packet boundary that reorders frames. A piece
    // that runs to the end has nothing to check.
    if (kept[i].endSec < clipSec - 0.02) even = (await copiedFramesRunEven(part)) && even
    parts.push(part)
  }

  // The timeline length of everything kept. Used as an explicit output ceiling:
  // `-shortest` is unreliable with stream copy, and an audio packet that ran past
  // the last video frame otherwise makes the joined audio read a second longer.
  const outputSec = kept.reduce((sum, piece) => sum + Math.max(0, piece.endSec - piece.startSec), 0)

  const listFile = path.join(scratchDir, 'parts.txt')
  // Written without a BOM: the concat demuxer reads this file literally and a BOM
  // makes it reject the first line.
  fs.writeFileSync(listFile, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')

  await ffmpegTo(
    [
      '-f', 'concat', '-safe', '0', '-i', listFile,
      // Same reason as the pieces: default mapping takes one audio stream out of a
      // clip that carries several.
      '-map', '0',
      // Video stays a copy; audio is re-encoded so the join can be cut to the
      // timeline's exact length. With a stream copy the last AAC packet overruns
      // the last video frame and the joined audio reads a second longer.
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', `${AUDIO_KBPS}k`,
      '-t', outputSec.toFixed(3),
      ...muxTail,
    ],
    out,
  )
  return even
}

/**
 * Writes the sequence to a new file: the pieces the user kept, in order, with a
 * stretch of black and silence wherever they lifted one out.
 *
 * Two paths, chosen from what the file itself allows:
 *
 *  - **Stream copy** when there are no gaps and every kept piece starts on a
 *    keyframe. Nothing but the audio is re-encoded, and only when track volumes were
 *    changed, so the result is the source's own frames, bit for bit, and the cut
 *    takes seconds rather than minutes. The copy is measured afterwards: a packet
 *    boundary is coarser than a frame, and a piece that came back with a break in it
 *    sends the cut down the other path rather than shipping a stray frame.
 *  - **Re-encode** otherwise, because a copy can only start where a keyframe is: it
 *    would have to keep up to a keyframe interval of the footage the user asked to
 *    remove, and a gap has no packets to copy at all. The encode matches the source's
 *    own bitrate so a cut does not degrade the clip the way compressing it would.
 *
 * The source is never written to; `out` is a path the caller owns.
 */
export async function writeSequence(req: WriteSequenceRequest): Promise<WriteSequenceResult> {
  const info = await probeClip(req.clipPath)
  if (!info || !info.durationSec) throw new Error('Could not read the clip')
  if (info.width < 2 || info.height < 2) throw new Error('Could not read the clip dimensions')

  const shape = layout(req.items)
  const gaps = shape.gaps.length
  if (!shape.kept.length) throw new Error('Nothing left to keep')

  const volumes = req.volumes ?? []
  const audioChanged = volumes.some((v) => v.volume !== 1)
  const probeInfo: ProbeAudioInfo = {
    streamCount: info.audioStreams,
    split: info.audioStreams > 1,
    labels: [],
  }

  /*
   * A sequence that keeps the clip end to end is the clip. Copy the file itself:
   * no keyframe scan, no remux, no encode. Cutting a clip and saving it without
   * lifting anything out is a real edit in the model, but it changes no frame, so
   * paying for a full re-encode there would be paying for nothing.
   */
  const kept = shape.kept
  const wholeClip =
    !gaps &&
    !audioChanged &&
    path.extname(req.out).toLowerCase() === path.extname(req.clipPath).toLowerCase() &&
    kept[0].startSec <= 0.001 &&
    kept.every((seg, i) => i === 0 || Math.abs(seg.startSec - kept[i - 1].endSec) <= 0.001) &&
    kept[kept.length - 1].endSec >= info.durationSec - 0.02
  if (wholeClip) {
    // Async: the main process also serves the window's IPC, and a long recording is
    // a second of blocking work if this is done on the calling thread.
    await fs.promises.copyFile(req.clipPath, req.out)
    const bytes = fs.statSync(req.out).size
    log.info(`Kept every frame of ${path.basename(req.clipPath)}: copied the file`)
    return { durationSec: info.durationSec, removedSec: 0, pieces: kept.length, gaps: 0, reencoded: false, bytes }
  }

  // A gap has no packets to copy. Otherwise each kept piece's start is checked on
  // its own: one short seek per distinct cut point instead of a demux of the whole
  // recording, which on a long clip or a slow drive is most of the wait.
  let reencoded = gaps > 0
  if (!reencoded) {
    for (const start of new Set(shape.kept.map((seg) => seg.startSec))) {
      if (!(await canCopyFrom(req.clipPath, start))) {
        reencoded = true
        break
      }
    }
  }
  let encoder = reencoded ? await detectGpuEncoder() : null
  // The source's own overall bitrate, floored: re-encoding a cut should land on the
  // clip's quality, not on a size target, so the user gets back what they had.
  const kbps = Math.max(MIN_VIDEO_KBPS, info.bitrateKbps)
  const pullbackSec = info.fps > 0 ? COPY_TAIL_PULLBACK_FRAMES / info.fps : 0.05
  // `+faststart` is an MP4 flag; a save that keeps the source's container (save a
  // copy writes `name-edit.mkv` for an MKV source) takes nothing else instead.
  const muxTail = req.out.toLowerCase().endsWith('.mp4') ? ['-movflags', '+faststart'] : []

  log.info(
    `${reencoded ? 'Re-encoding' : 'Copying'} ${shape.kept.length} piece(s)` +
      `${gaps ? ` holding ${gaps} gap(s)` : ''} of ${path.basename(req.clipPath)}: ` +
      `${shape.duration.toFixed(2)}s out` +
      `${audioChanged ? ', audio scaled' : ''}${reencoded && encoder ? ` (${encoder})` : ''}`,
  )

  // Only the copy path needs parts on disk; the re-encode joins in the filter graph.
  const scratch = reencoded ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-cut-'))
  const audio = audioChanged ? pieceAudioArgs(probeInfo, volumes) : null

  try {
    // The ways the sequence can be written: a single piece or a join, copied or
    // re-encoded. A copy reports whether its frames came out whole.
    const write = async (encode: boolean, enc: string | null): Promise<boolean> => {
      if (encode) {
        await ffmpegTo(
          concatFilterArgs(
            req.clipPath,
            req.items,
            probeInfo,
            volumes,
            enc,
            kbps,
            { width: info.width, height: info.height, fps: info.fps },
            muxTail,
          ),
          req.out,
        )
        return true
      }
      if (shape.kept.length === 1) {
        const one = shape.kept[0]
        await ffmpegTo(copyArgs(req.clipPath, one, copyLengthSec(one, pullbackSec, info.durationSec), audio, muxTail), req.out)
        // A piece that runs to the clip's end has no cut at its tail, so its packets
        // cannot reorder anything: there is nothing for the check to catch.
        return one.endSec >= info.durationSec - 0.02 ? true : copiedFramesRunEven(req.out)
      }
      return concatCopies(req.clipPath, shape.kept, scratch!, req.out, pullbackSec, info.durationSec, audio, muxTail)
    }

    const even = await write(reencoded, encoder)

    if (!reencoded && !even) {
      // The packets could not express the cut: a piece came back with a stray frame
      // or a break in its timeline. Re-encode instead, so nothing the user removed
      // is left in the file.
      reencoded = true
      encoder = await detectGpuEncoder()
      log.info('The stream copy did not line up at a seam; re-encoding the cut instead')
      await write(true, encoder)
    }

    const result = await probeClip(req.out)
    if (!result?.durationSec) throw new Error('The cut produced no readable video')

    const bytes = fs.statSync(req.out).size
    // Measured against the output, not echoed back from the request: a copy can
    // keep a frame or two of the removed range at a seam, and the readout should
    // say what the file holds.
    const removedSec = Math.max(0, Math.round((info.durationSec - result.durationSec) * 100) / 100)

    log.info(
      `Wrote ${path.basename(req.out)}: ${result.durationSec.toFixed(2)}s, ${shape.kept.length} piece(s)` +
        `${gaps ? ` + ${gaps} gap(s)` : ''}, ${removedSec.toFixed(2)}s removed` +
        `${reencoded ? ' (re-encoded)' : ' (stream copy)'}`,
    )

    return {
      durationSec: result.durationSec,
      removedSec,
      pieces: shape.kept.length,
      gaps,
      reencoded,
      bytes,
    }
  } finally {
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}
