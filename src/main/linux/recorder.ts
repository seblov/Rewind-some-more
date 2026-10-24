import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scope } from '../logger.js'
import { ffmpegTo, resolveFfmpeg } from '../ffmpeg.js'
import { RECORDINGS_SUBDIR, type VisualQuality } from '@shared/constants.js'

const log = scope('Recorder')

/**
 * The rolling-buffer capture process.
 *
 * One ffmpeg process reads the screen and every Pulse stream, encodes once, and
 * writes one-second MP4 segments into a ring. Saving is a concat of the segments
 * that are still inside the window, so there is no second encode and no copy of
 * the last minute in memory.
 *
 * The process has to be stopped for the current segment to be finalized (an MP4
 * has no usable index until it is closed), so a save costs a short capture gap.
 * The alternative, MPEG-TS byte concatenation, is unreadable by the bundled
 * static ffmpeg: it segfaults on any TS input. MP4 segments concatenate cleanly.
 */

export type CaptureTarget =
  | { kind: 'display'; display: string; x: number; y: number; width: number; height: number }
  | { kind: 'window'; display: string; windowId: string; width: number; height: number }

export interface RecorderStream {
  kind: 'desktop' | 'microphone' | 'device'
  source: string
  label: string
  volume: number
  muted: boolean
  gain?: number
}

export interface RecorderOptions {
  target: CaptureTarget
  /** In capture order: desktop, microphone, then extra devices. */
  streams: RecorderStream[]
  fps: number
  quality: VisualQuality
  outputResolution: 'native' | '1080p' | '720p'
  outputDir: string
  bufferDuration: number
}

interface Segment {
  number: number
  path: string
  size: number
}

const SEGMENT_TIME_SEC = 1
/** Extra segments kept past the requested window so a save can always fill it. */
const WINDOW_SLACK = 3

/**
 * Encoders that must not outlive the app.
 *
 * Windows binds obs64 to a job object; Linux has no equivalent here, and a hard
 * `app.exit()` (the self-tests do this) skips the async shutdown path. A last-chance
 * exit hook kills any child still running, so quitting never leaves an ffmpeg
 * holding the screen and the Pulse streams.
 */
const liveChildren = new Set<ChildProcess>()
/** True once this process has actually created the ring; a second instance must not clear it. */
let ownsRing = false
process.once('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (ownsRing) {
    try {
      fs.rmSync(ringRoot(), { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
})

const QUALITY: Record<VisualQuality, { preset: string; crf: number; bitrate: number }> = {
  low: { preset: 'ultrafast', crf: 28, bitrate: 4_000 },
  balanced: { preset: 'superfast', crf: 23, bitrate: 8_000 },
  quality: { preset: 'veryfast', crf: 18, bitrate: 20_000 },
}

export function qualityTarget(quality: VisualQuality): string {
  return `CRF ${QUALITY[quality].crf}`
}

/** Must match BUFFER_DURATION_MAX; duplicated here to keep the module free of the renderer's consts. */
const BUFFER_MAX_SEC = 300

let cachedRing: string | null = null

/**
 * Ring location.
 *
 * tmpfs when it can hold the window: the buffer is written continuously, and on
 * an SSD a 60s 8 Mbps window is 3.6 GB/hour of pointless writes. Falls back to
 * userData when /dev/shm is too small for the longest window at the best quality.
 */
function ringRoot(): string {
  if (cachedRing) return cachedRing
  const shm = '/dev/shm'
  try {
    const st = fs.statfsSync(shm)
    const free = st.bavail * st.bsize
    // Worst case: the longest window the engine accepts, at 20 Mbps video plus
    // six 160 kbps audio tracks.
    const worstBytes = (BUFFER_MAX_SEC * (20_000 + 960) * 1000) / 8
    if (free > worstBytes * 1.25) {
      cachedRing = path.join(shm, `rewind-replay-${process.getuid?.() ?? 0}`)
      return cachedRing
    }
  } catch {
    /* no tmpfs; use the data volume */
  }
  cachedRing = path.join(os.tmpdir(), `rewind-replay-${process.getuid?.() ?? 0}`)
  return cachedRing
}

export function replayRingDir(): string {
  return ringRoot()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function uniqueFile(dir: string, base: string, ext: string): string {
  fs.mkdirSync(dir, { recursive: true })
  let candidate = path.join(dir, `${base}${ext}`)
  let n = 2
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++})${ext}`)
  return candidate
}

function listSegments(dir: string): Segment[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Segment[] = []
  for (const name of names) {
    const m = /^seg-(\d+)\.mp4$/.exec(name)
    if (!m) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.size > 0) out.push({ number: Number(m[1]), path: full, size: st.size })
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out.sort((a, b) => a.number - b.number)
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export class LinuxRecorder {
  private child: ChildProcess | null = null
  private options: RecorderOptions | null = null
  private active = false
  private startedAt = 0
  private nextNumber = 0
  private lock: Promise<unknown> = Promise.resolve()
  private pruneTimer: NodeJS.Timeout | null = null
  private saveInFlight: Promise<string> | null = null
  private recordingStart: number | null = null
  private recordingStartedAt = 0
  private stderr = ''
  private intentionalStop = false
  private labels: string[] = []

  isActive(): boolean {
    return this.active
  }

  bufferStartedAt(): number {
    return this.startedAt
  }

  audioTrackLabels(): string[] {
    return [...this.labels]
  }

  setBufferDuration(seconds: number): void {
    if (this.options) this.options.bufferDuration = seconds
    this.prune()
  }

  setOutputDir(dir: string): void {
    if (this.options) this.options.outputDir = dir
  }

  isRecording(): boolean {
    return this.recordingStart !== null
  }

  recordingStartedAtMs(): number {
    return this.recordingStartedAt
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private dir(): string {
    return ringRoot()
  }

  async start(options: RecorderOptions, opts: { clear?: boolean } = {}): Promise<void> {
    await this.enqueue(async () => {
      this.options = options
      if (opts.clear) this.clearRing()
      if (this.active) await this.stopInternal(false)
      await this.startInternal()
    })
  }

  /** Restarts the encode with new options, keeping the segments already buffered. */
  async apply(options: RecorderOptions): Promise<void> {
    await this.enqueue(async () => {
      this.options = options
      if (!this.active) return
      await this.stopInternal(false)
      await this.startInternal()
    })
  }

  async stop(opts: { clear?: boolean; finishRecording?: boolean } = {}): Promise<string | null> {
    return this.enqueue(async () => {
      let finished: string | null = null
      if (opts.finishRecording && this.isRecording()) {
        finished = await this.stitchRecording(null)
      }
      await this.stopInternal(opts.clear !== false)
      return finished
    })
  }

  async save(): Promise<string> {
    if (this.saveInFlight) return this.saveInFlight
    const flight = this.enqueue(async () => {
      if (!this.options || !this.active) throw new Error('Replay buffer is not running')
      const out = uniqueFile(this.options.outputDir, `Replay ${stamp()}`, '.mp4')
      await this.stopInternal(false)
      try {
        await this.concat(this.bufferSegments(), out)
      } finally {
        await this.startInternal()
      }
      log.info(`Replay saved: ${out}`)
      return out
    }).finally(() => {
      this.saveInFlight = null
    })
    this.saveInFlight = flight
    return flight
  }

  startRecording(): void {
    if (!this.active) throw new Error('The buffer is not running, so nothing would be recorded')
    if (this.recordingStart !== null) return
    const segments = listSegments(this.dir())
    this.recordingStart = segments.at(-1)?.number ?? this.nextNumber
    this.recordingStartedAt = Date.now()
    log.info(`Continuous recording started (from segment ${this.recordingStart})`)
  }

  async stopRecording(): Promise<string> {
    return this.enqueue(async () => {
      if (this.recordingStart === null) throw new Error('Not currently recording')
      const out = uniqueFile(path.join(this.options?.outputDir ?? this.dir(), RECORDINGS_SUBDIR), `Recording ${stamp()}`, '.mp4')
      const startedAt = this.recordingStartedAt
      await this.stopInternal(false)
      try {
        const files = this.recordingSegments()
        if (!files.length) throw new Error('Recording produced no footage - it was stopped too quickly')
        await this.concat(files, out)
      } catch (e) {
        await this.startInternal().catch(() => {})
        this.recordingStart = null
        throw e
      }
      this.recordingStart = null
      await this.startInternal()
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      log.info(`Recording saved after ${seconds}s: ${out}`)
      return out
    })
  }

  private async stitchRecording(out: string | null): Promise<string | null> {
    const target =
      out ?? uniqueFile(path.join(this.options?.outputDir ?? this.dir(), RECORDINGS_SUBDIR), `Recording ${stamp()}`, '.mp4')
    await this.stopInternal(false)
    try {
      const files = this.recordingSegments()
      if (!files.length) return null
      await this.concat(files, target)
      this.recordingStart = null
      return target
    } catch (e) {
      log.warn('Could not stitch the recording:', e)
      this.recordingStart = null
      return null
    }
  }

  async recover(): Promise<void> {
    await this.enqueue(async () => {
      if (this.active || !this.options) return
      await this.startInternal()
    })
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      await this.stopInternal(true)
    })
  }

  // -------------------------------------------------------------------------
  // Process management
  // -------------------------------------------------------------------------

  private bufferSegments(): Segment[] {
    const all = listSegments(this.dir())
    const keep = Math.max(2, (this.options?.bufferDuration ?? 60) + WINDOW_SLACK)
    return all.slice(-keep)
  }

  private recordingSegments(): Segment[] {
    const start = this.recordingStart ?? 0
    return listSegments(this.dir()).filter((s) => s.number >= start)
  }

  private clearRing(): void {
    // Remove the directory itself: a ring can also hold a concat list, a stale
    // audio pipe from an older build, or a segment whose name no longer matches.
    try {
      fs.rmSync(this.dir(), { recursive: true, force: true })
    } catch {
      /* nothing to clear */
    }
    this.nextNumber = 0
    this.startedAt = 0
  }

  private async startInternal(): Promise<void> {
    if (!this.options) throw new Error('Recorder has no options')
    if (this.active) return

    const options = this.options
    const dir = this.dir()
    fs.mkdirSync(dir, { recursive: true })
    ownsRing = true
    this.prune()

    const segments = listSegments(dir)
    this.nextNumber = segments.at(-1) ? segments.at(-1)!.number + 1 : 0

    const audio = this.buildAudio(options)
    this.labels = audio.labels

    const args = this.buildArgs(options, audio, dir, this.nextNumber)
    this.stderr = ''
    this.intentionalStop = false

    const child = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    liveChildren.add(child)
    child.stderr?.on('data', (d) => {
      this.stderr = (this.stderr + String(d)).slice(-8192)
    })
    child.on('exit', (code, signal) => {
      liveChildren.delete(child)
      if (this.child !== child) return
      this.child = null
      if (this.intentionalStop) return
      this.active = false
      this.clearTimers()
      log.error(`Capture process exited unexpectedly (code=${code}, signal=${signal}): ${this.stderr.trim()}`)
    })

    // A segment only appears once the first keyframe lands; without this wait the
    // caller would report a running buffer that has not written anything yet.
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      if (this.child === null) throw new Error(this.stderr.trim() || 'Capture process exited before writing a frame')
      if (listSegments(dir).some((s) => s.number >= this.nextNumber)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!listSegments(dir).some((s) => s.number >= this.nextNumber)) {
      await this.stopInternal(false)
      throw new Error(this.stderr.trim() || 'Capture process produced no frames')
    }

    this.active = true
    if (!this.startedAt) this.startedAt = Date.now()
    this.pruneTimer = setInterval(() => this.prune(), 1000)
    this.pruneTimer.unref?.()
    log.info(
      `Capture started: ${options.target.kind} ${options.target.width}x${options.target.height} @ ${options.fps}fps, ` +
        `${audio.streams.length} audio input(s), ${this.labels.join(' / ')}`,
    )
  }

  private buildAudio(options: RecorderOptions): { streams: RecorderStream[]; labels: string[] } {
    // Desktop is track 2; mic is track 3 when present; every extra device shares
    // track 4, matching the Windows layout (`deviceTrack` returns 4).
    const streams = [...options.streams]
    if (!streams.length) return { streams, labels: [] }
    const labels: string[] = ['Mix', 'Desktop']
    const mic = streams.find((s) => s.kind === 'microphone')
    if (mic) labels.push('Microphone')
    const devices = streams.filter((s) => s.kind === 'device')
    // The device labels are joined exactly as `buildTrackLabels` does.
    if (devices.length) labels.push(devices.map((d) => d.label).join(' + '))
    return { streams, labels }
  }

  private buildArgs(
    options: RecorderOptions,
    audio: { streams: RecorderStream[]; labels: string[] },
    dir: string,
    startNumber: number,
  ): string[] {
    const q = QUALITY[options.quality]
    const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y']

    args.push('-f', 'x11grab', '-framerate', String(options.fps))
    if (options.target.kind === 'display') {
      // `-grab_x`/`-grab_y`, not `-x`/`-y`: ffmpeg parses the short forms as
      // generic options and then stops treating the next argument as an input,
      // which fails with "Protocol not found" for the display name.
      args.push(
        '-video_size', `${options.target.width}x${options.target.height}`,
        '-grab_x', String(options.target.x),
        '-grab_y', String(options.target.y),
      )
      args.push('-i', options.target.display)
    } else {
      args.push('-window_id', String(parseInt(options.target.windowId, 16) || 0))
      args.push('-i', options.target.display)
    }

    for (const stream of audio.streams) {
      // Pulse input rather than a parec-fed FIFO: a blocking read on a FIFO makes
      // ffmpeg ignore SIGINT and stalls the save until it is killed, losing the
      // segment that was being written.
      args.push('-f', 'pulse', '-i', stream.source)
    }

    const filters: string[] = []
    let videoMap = '0:v:0'
    const videoChain: string[] = []

    // x264 needs even dimensions. A window can be any size (measured: a 816x641
    // file dialog), and the window manager's frame can add an odd row too.
    if (options.target.kind === 'window') videoChain.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')

    // Scale after capture so the canvas in the file matches the chosen output size.
    if (options.outputResolution !== 'native') {
      const ceiling = options.outputResolution === '1080p' ? 1080 : 720
      if (options.target.height > ceiling) {
        const scale = ceiling / options.target.height
        const w = Math.round(options.target.width * scale)
        videoChain.push(`scale=${w - (w % 2)}:${ceiling}`)
      }
    }

    if (videoChain.length) {
      videoMap = '[video]'
      filters.push(`[0:v:0]${videoChain.join(',')}[video]`)
    }

    const desktopIndex = audio.streams.findIndex((s) => s.kind === 'desktop')
    const micIndex = audio.streams.findIndex((s) => s.kind === 'microphone')
    const deviceIndexes = audio.streams.flatMap((s, i) => (s.kind === 'device' ? [i] : []))

    if (audio.streams.length) {
      const mixLabels: string[] = []
      for (let i = 0; i < audio.streams.length; i++) {
        const s = audio.streams[i]
        const gain = s.muted ? 0 : s.volume * (s.gain ?? 1)
        filters.push(
          `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
            `aresample=async=1:first_pts=0,volume=${gain.toFixed(4)},asplit=2[t${i}][m${i}]`,
        )
        mixLabels.push(`[m${i}]`)
      }
      filters.push(
        `${mixLabels.join('')}amix=inputs=${audio.streams.length}:normalize=0:dropout_transition=0,` +
          `alimiter=limit=0.95[mix]`,
      )

      // Every extra device shares one track, matching the Windows layout
      // (`deviceTrack` returns TRACK.DEVICE_BASE for all of them). Without this
      // they each became their own stream and the recorded labels no longer
      // described the file.
      if (deviceIndexes.length > 1) {
        filters.push(
          `${deviceIndexes.map((i) => `[t${i}]`).join('')}amix=inputs=${deviceIndexes.length}:normalize=0,` +
            `alimiter=limit=0.95[devices]`,
        )
      }
    }

    if (filters.length) args.push('-filter_complex', filters.join(';'))

    args.push('-map', videoMap)
    if (audio.streams.length) {
      args.push('-map', '[mix]')
      if (desktopIndex >= 0) args.push('-map', `[t${desktopIndex}]`)
      if (micIndex >= 0) args.push('-map', `[t${micIndex}]`)
      if (deviceIndexes.length === 1) args.push('-map', `[t${deviceIndexes[0]}]`)
      else if (deviceIndexes.length > 1) args.push('-map', '[devices]')
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', q.preset,
      '-crf', String(q.crf),
      '-pix_fmt', 'yuv420p',
      '-g', String(options.fps),
      '-keyint_min', String(options.fps),
      '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
    )
    if (audio.streams.length) {
      args.push('-c:a', 'aac', '-b:a', '160k')
      const titles = ['Mix']
      if (desktopIndex >= 0) titles.push('Desktop')
      if (micIndex >= 0) titles.push('Microphone')
      if (deviceIndexes.length) titles.push(deviceIndexes.map((i) => audio.streams[i].label).join(' + '))
      titles.forEach((title, i) => args.push(`-metadata:s:a:${i}`, `title=${title}`))
    }

    args.push(
      '-f', 'segment',
      '-segment_time', String(SEGMENT_TIME_SEC),
      '-reset_timestamps', '1',
      '-segment_format', 'mp4',
      '-segment_start_number', String(startNumber),
      path.join(dir, 'seg-%06d.mp4'),
    )
    return args
  }

  private async stopInternal(clear: boolean): Promise<void> {
    const t0 = Date.now()
    this.clearTimers()
    this.intentionalStop = true

    const child = this.child
    this.child = null

    // SIGINT is enough with Pulse inputs: ffmpeg closes the current segment and
    // exits in a few hundred milliseconds. SIGKILL is only the fallback.
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGINT')
      } catch {
        /* already gone */
      }
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ])
    }

    if (child && child.exitCode === null) {
      log.warn('ffmpeg did not stop on SIGINT; killing it (the last segment may be lost)')
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    log.info(`Capture process stopped in ${Date.now() - t0}ms`)

    this.active = false
    if (clear) this.clearRing()
  }

  private clearTimers(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
  }

  private prune(): void {
    const all = listSegments(this.dir())
    if (!all.length) return
    if (this.isRecording()) {
      // Keep everything from the recording's first segment; drop only older
      // segments the rolling window no longer needs.
      const keepFrom = this.recordingStart ?? all[0].number
      const before = all.filter((s) => s.number < keepFrom)
      const keepBefore = Math.max(0, (this.options?.bufferDuration ?? 60) + WINDOW_SLACK)
      for (const s of before.slice(0, Math.max(0, before.length - keepBefore))) this.remove(s.path)
      return
    }
    const keep = Math.max(2, (this.options?.bufferDuration ?? 60) + WINDOW_SLACK)
    for (const s of all.slice(0, Math.max(0, all.length - keep))) this.remove(s.path)
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* a segment being read by a save is retried next tick */
    }
  }

  private async concat(segments: Segment[], out: string): Promise<void> {
    if (!segments.length) throw new Error('No buffered footage to save')
    const t0 = Date.now()
    const list = path.join(this.dir(), `concat-${Date.now()}.txt`)
    fs.writeFileSync(
      list,
      segments.map((s) => `file ${shellQuote(s.path)}`).join('\n') + '\n',
      'utf8',
    )
    try {
      await ffmpegTo(
        ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-movflags', '+faststart'],
        out,
      )
    } catch (e) {
      try {
        fs.rmSync(out, { force: true })
      } catch {
        /* ignore */
      }
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Could not join the buffered segments: ${message}`)
    } finally {
      try {
        fs.rmSync(list, { force: true })
      } catch {
        /* ignore */
      }
      log.info(`Joined ${segments.length} segment(s) in ${Date.now() - t0}ms`)
    }
  }
}

