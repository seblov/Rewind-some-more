/**
 * Cut-out test: the sequence model, and the real writer end to end.
 *
 * Run with:  npm run test:cut     (node --test scripts/test-cut.mjs)
 *
 * The first half is the model (`@shared/cut.js`): where a cut lands, what a delete
 * closes up, what a lift leaves behind, and where each piece falls in the output.
 * Fast, no files.
 *
 * The second half makes clips with the bundled ffmpeg, runs the real `writeSequence`
 * over them and measures what came out. Durations, stream counts and black bands
 * cover both paths; for the stream-copy path the frame hashes are compared against
 * the source's, which is the only thing that proves a "no re-encode" cut really is
 * one, that the join is in the right order, and that the removed footage is gone.
 * The re-encoded path is checked by length, by a full decode, and by audio against
 * video, not by hash: an encode is not bit-identical by nature.
 *
 * The module under test is the real main-process file, bundled with the same esbuild
 * configuration the app builds with (scripts/build-main.mjs). `electron` is stubbed:
 * the cut path only asks it where the user-data folder is.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(os.tmpdir(), 'rewind-cut-test')
/**
 * The bundle lives under the repo rather than in the temp folder on purpose: its
 * `require('ffmpeg-static')` has to resolve against the project's node_modules, which
 * a file in the system temp directory cannot do. `out/` is gitignored build output.
 */
const bundleDir = path.join(root, 'out', 'test')
const ffmpeg = require('ffmpeg-static')

/** Rewind's keyframe interval, in seconds, and the frame rate the test clips are made at. */
const KEYFRAME_SEC = 2
const FPS = 30
const SOURCE_SEC = 60
const TRACKS = 3

let cut

/** Bundles the real module, stubbing the one Electron API the cut path touches. */
async function loadCutModule() {
  fs.mkdirSync(bundleDir, { recursive: true })
  const out = path.join(bundleDir, 'cut.cjs')
  await build({
    stdin: {
      contents: [
        `export { writeSequence, probeKeyframes, copiedFramesRunEven } from './src/main/cut.ts'`,
        `export { probe } from './src/main/ffmpeg.ts'`,
        `export { log } from './src/main/logger.ts'`,
        `export {
           layout, cutTarget, cutAt, deleteItems, canSave, keptSec, snapToFrame,
           splicePeaks, formatTimecode, parseTimecode, spanAtOut, srcAt, outAt, MIN_SEGMENT_SEC,
         } from './src/shared/cut.ts'`,
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    alias: { '@shared': path.join(root, 'src/shared') },
    external: ['electron', 'ffmpeg-static'],
    logLevel: 'warning',
  })

  const module = require('module')
  const originalLoad = module._load
  const electron = { app: { isPackaged: false, getPath: () => path.join(work, 'userData'), getAppPath: () => root } }
  module._load = function (request, ...rest) {
    return request === 'electron' ? electron : originalLoad.call(this, request, ...rest)
  }
  try {
    // eslint-disable-next-line import/no-dynamic-require
    return require(out)
  } finally {
    module._load = originalLoad
  }
}

/**
 * A source clip shaped like a Rewind recording: 30 fps, a keyframe every 2s, and
 * three audio tracks (the mix OBS writes plus Desktop and Microphone).
 */
async function makeSource(name, seconds = SOURCE_SEC) {
  const file = path.join(work, name)
  const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}:duration=${seconds}`]
  for (let t = 0; t < TRACKS; t++) args.push('-f', 'lavfi', '-i', `sine=frequency=${440 + t * 220}:sample_rate=48000:duration=${seconds}`)
  args.push('-map', '0:v:0')
  for (let t = 0; t < TRACKS; t++) args.push('-map', `${t + 1}:a:0`)
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    // Fixed GOP, no scene-cut keyframes: the cut points in the assertions below are
    // only predictable if `g` says exactly where the keyframes are.
    '-g', String(FPS * KEYFRAME_SEC), '-keyint_min', String(FPS * KEYFRAME_SEC), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', file,
  )
  await run(ffmpeg, args, { maxBuffer: 1 << 28 })
  return file
}

/** One md5 per video frame, in presentation order. */
async function frameHashes(file) {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-an', '-f', 'framemd5', '-'], {
    maxBuffer: 1 << 28,
  })
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('0,'))
    .map((line) => line.split(',').pop().trim())
}

/** Seconds of audio the track actually decodes to, used to check sync against video. */
async function audioSeconds(file, stream = 0) {
  const { stdout } = await run(
    ffmpeg,
    ['-hide_banner', '-v', 'error', '-i', file, '-map', `0:a:${stream}`, '-ac', '1', '-f', 's16le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 },
  )
  return stdout.length / 2 / 48000
}

/** Mean loudness of one audio stream, in dB. -Infinity for digital silence. */
async function meanVolumeDb(file, stream) {
  const { stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-v', 'info', '-i', file, '-map', `0:a:${stream}`, '-af', 'volumedetect', '-f', 'null', 'NUL'],
    { maxBuffer: 1 << 28 },
  )
  const raw = /mean_volume:\s*(\S+)/.exec(stderr)?.[1]
  if (raw === undefined) return NaN
  return raw === '-inf' || raw === 'inf' ? -Infinity : Number(raw)
}

/** Every stretch the file spends on black, as `[startSec, endSec]`. */
async function blackBands(file) {
  const { stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-v', 'info', '-i', file, '-an', '-vf', 'blackdetect=d=0.4:pic_th=0.99', '-f', 'null', 'NUL'],
    { maxBuffer: 1 << 28 },
  )
  const bands = []
  for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
    bands.push([Number(m[1]), Number(m[2])])
  }
  return bands
}

const keep = (id, srcIn, srcOut) => ({ id, kind: 'keep', srcIn, srcOut })
const gap = (id, durSec) => ({ id, kind: 'gap', durSec })
/** The sequence a set of kept source ranges makes, for the writer cases below. */
const keeps = (ranges) => ranges.map((r, i) => keep(i + 1, r.startSec, r.endSec))
const outPath = (name) => path.join(work, name)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(path.join(work, 'userData'), { recursive: true })
  cut = await loadCutModule()
  // Mirrors the module's own log to the console, so a run reports which path it took.
  cut.log.init()
})

after(() => {
  // Left in place for inspection on Windows (a file handle can hold the directory);
  // nothing outside the temp folder is touched either way.
  void sleep
})

describe('the sequence model', () => {
  // Called through `cut`, which is loaded in the top-level `before`: a suite body runs
  // before that hook, so the module cannot be read at describe time.

  it('places pieces end to end and reports where each falls', () => {
    const l = cut.layout([keep(1, 0, 10), gap(2, 5), keep(3, 20, 30)])
    assert.equal(l.duration, 25)
    assert.deepEqual(l.kept, [
      { startSec: 0, endSec: 10 },
      { startSec: 20, endSec: 30 },
    ])
    assert.deepEqual(l.gaps, [5])
    assert.deepEqual(
      l.spans.map((s) => [s.outIn, s.outOut]),
      [
        [0, 10],
        [10, 15],
        [15, 25],
      ],
    )
  })

  it('maps output time to source time, and nothing at all over a gap', () => {
    const { spans } = cut.layout([keep(1, 0, 10), gap(2, 5), keep(3, 20, 30)])
    assert.equal(cut.srcAt(spans, 4), 4)
    assert.equal(cut.srcAt(spans, 12.5), null, 'a gap has no source frame')
    assert.equal(cut.srcAt(spans, 20), 25, 'the last piece starts at 20s of source time')
    assert.equal(cut.srcAt(spans, 25), null, 'past the end there is nothing')

    assert.equal(cut.outAt(spans, 9.5), 9.5)
    assert.equal(cut.outAt(spans, 15), null, 'removed footage is not in the output')
    assert.equal(cut.outAt(spans, 25), 20)
  })

  it('refuses a cut with no room for two pieces, or none under the playhead', () => {
    const items = [keep(1, 0, 10)]
    assert.equal(cut.cutTarget(items, 5, 30).index, 0)
    assert.match(cut.cutTarget(items, 0, 30).error, /already cut/i)
    assert.match(cut.cutTarget(items, 9.95, 30).error, /already cut/i)
    assert.match(cut.cutTarget(items, 10, 30).error, /no clip/i, 'the end of the sequence is not a cut')
    assert.match(cut.cutTarget(items, -1, 30).error, /no clip/i)
    assert.match(cut.cutTarget([keep(1, 0, 10), gap(2, 4)], 11, 30).error, /no clip/i)
  })

  it('snaps a cut to the frame grid', () => {
    const [a, b] = cut.cutAt([keep(1, 0, 10)], 5.012, 30, (() => { let n = 10; return () => n++ })())
    assert.equal(b.srcIn, a.srcOut, 'the pieces must meet exactly')
    assert.ok(Math.abs(a.srcOut - 5) < 1 / 30 / 2, `snapped to ${a.srcOut}, expected a frame near 5s`)
    assert.deepEqual([a.srcIn, b.srcOut], [0, 10], 'the outside edges must not move')
  })

  it('splits the piece under the playhead and leaves the others alone', () => {
    const items = [keep(1, 0, 10), gap(2, 5), keep(3, 20, 30)]
    let id = 100
    const next = cut.cutAt(items, 17, 30, () => id++)
    assert.equal(next.length, 4)
    assert.deepEqual(
      next.map((i) => [i.kind, i.kind === 'keep' ? i.srcIn : i.durSec, i.kind === 'keep' ? i.srcOut : null]),
      [
        ['keep', 0, 10],
        ['gap', 5, null],
        ['keep', 20, 22],
        ['keep', 22, 30],
      ],
    )
    // The playhead sat 2s into the last piece, which starts at source 20s.
    assert.equal(cut.layout(next).duration, cut.layout(items).duration, 'a cut must not change the length')
  })

  it('closes the sequence up when a piece is deleted', () => {
    const items = [keep(1, 0, 10), gap(2, 5), keep(3, 20, 30)]
    const next = cut.deleteItems(items, [3], 'ripple')
    assert.deepEqual(next.map((i) => i.id), [1, 2])
    assert.equal(cut.layout(next).duration, 15)
    assert.equal(cut.layout(next).kept.length, 1)
  })

  it('leaves a gap of the same length when a piece is lifted, keeping its id', () => {
    const items = [keep(1, 0, 10), keep(2, 20, 30)]
    const next = cut.deleteItems(items, [2], 'lift')
    assert.deepEqual(next[1], { id: 2, kind: 'gap', durSec: 10 })
    assert.equal(cut.layout(next).duration, 20, 'a lift must not change the length')
  })

  it('refuses a save with nothing, or almost nothing, to keep', () => {
    assert.equal(cut.canSave([keep(1, 0, 10)]).ok, true)
    assert.equal(cut.canSave([keep(1, 0, 10), gap(2, 4)]).ok, true)
    assert.equal(cut.canSave([gap(1, 4)]).ok, false)
    assert.match(cut.canSave([gap(1, 4)]).error, /nothing left/i)
    assert.equal(cut.canSave([]).ok, false)
    assert.match(cut.canSave([keep(1, 0, 0.5)]).error, /second left/i)
  })

  it('counts only the pieces as kept seconds', () => {
    assert.equal(cut.keptSec([keep(1, 0, 10), gap(2, 5), keep(3, 20, 30)]), 20)
  })

  it('splices the waveform to match the sequence', () => {
    // Ten buckets over ten seconds: one per second, each bar the second it covers.
    const peaks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const out = cut.splicePeaks(peaks, 10, [keep(1, 0, 3), gap(2, 2), keep(3, 7, 10)])
    assert.deepEqual(
      out.filter((_, i) => i < 3),
      [1, 2, 3],
    )
    assert.deepEqual(out.slice(3, 5), [0, 0], 'a gap plays silence, so its bars are empty')
    assert.deepEqual(out.slice(5), [8, 9, 10])
  })

  it('leaves an untouched clip exactly as the engine measured it', () => {
    const peaks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert.deepEqual(cut.splicePeaks(peaks, 10, [keep(1, 0, 10)]), peaks)
    assert.deepEqual(cut.splicePeaks([], 10, [keep(1, 0, 10)]), [])
    assert.deepEqual(cut.splicePeaks(peaks, 0, [keep(1, 0, 10)]), [])
  })

  it('rounds to a frame, and leaves the time alone without a frame rate', () => {
    assert.equal(cut.snapToFrame(5.012, 30), 5)
    assert.equal(cut.snapToFrame(5.02, 30), 5 + 1 / 30)
    assert.equal(cut.snapToFrame(5.017, 0), 5.017)
  })

  it('writes a timecode with frames, or milliseconds without a rate', () => {
    assert.equal(cut.formatTimecode(0, 30), '00:00:00:00')
    assert.equal(cut.formatTimecode(61.5, 30), '00:01:01:15')
    assert.equal(cut.formatTimecode(3661, 0), '01:01:01.000')
    assert.equal(cut.formatTimecode(-5, 30), '00:00:00:00')
  })

  it('parses the timecode shapes a person types', () => {
    assert.equal(cut.parseTimecode(12.5), 12.5)
    assert.equal(cut.parseTimecode('12'), 12)
    assert.equal(cut.parseTimecode('12.25'), 12.25)
    assert.equal(cut.parseTimecode('0:10'), 10)
    assert.equal(cut.parseTimecode('01:02:03.250'), 3723.25)
    assert.ok(Number.isNaN(cut.parseTimecode('')))
    assert.ok(Number.isNaN(cut.parseTimecode('  ')))
    assert.ok(Number.isNaN(cut.parseTimecode('abc')))
    assert.ok(Number.isNaN(cut.parseTimecode('1:2:3:4')))
    assert.ok(Number.isNaN(cut.parseTimecode('-1')))
    assert.ok(Number.isNaN(cut.parseTimecode('2m')))
    assert.ok(Number.isNaN(cut.parseTimecode(Number.NaN)))
  })
})

describe('writeSequence', () => {
  let source
  let sourceHashes

  before(async () => {
    source = await makeSource('source.mp4')
    sourceHashes = await frameHashes(source)
    assert.equal(sourceHashes.length, SOURCE_SEC * FPS)
  })

  /**
   * What "stream copy" means, checked frame by frame: the output must be the source's
   * own frames with whole blocks deleted.
   *
   * That proves three things at once -- every frame is a source frame (nothing was
   * re-encoded), the pieces are in their original order, and what disappeared is the
   * range that was asked for. The tolerance is the couple of frames a copy rounds to:
   * a piece stops on a packet boundary and the cut asks for two frames less than the
   * boundary so the stop lands cleanly, which is the trade this path makes against
   * re-encoding (see main/cut.ts).
   */
  function assertBlocksDropped(outputHashes, expectedBlocks, label, slack = 3) {
    const blocks = []
    let s = 0
    for (const hash of outputHashes) {
      if (sourceHashes[s] === hash) {
        s++
        continue
      }
      const resume = sourceHashes.indexOf(hash, s)
      assert.ok(resume >= 0, `${label}: an output frame is not the source's (was it re-encoded?)`)
      blocks.push([s, resume])
      s = resume + 1
    }
    // Whatever the output did not use is what was removed from the end of the clip.
    if (s < sourceHashes.length) blocks.push([s, sourceHashes.length])

    assert.equal(
      blocks.length,
      expectedBlocks.length,
      `${label}: dropped ${JSON.stringify(blocks)}, expected ${JSON.stringify(expectedBlocks)}`,
    )
    blocks.forEach(([from, to], i) => {
      const [wantFrom, wantTo] = expectedBlocks[i]
      assert.ok(
        Math.abs(from - wantFrom) <= slack && Math.abs(to - wantTo) <= slack,
        `${label}: dropped frames ${from}..${to}, asked for about ${wantFrom}..${wantTo}`,
      )
    })
    return blocks
  }

  /** A copied cut lands within a few frames of the ask; a re-encoded one is exact. */
  function assertDuration(actual, wanted, slack, label) {
    assert.ok(Math.abs(actual - wanted) <= slack, `${label}: ${actual.toFixed(2)}s, wanted ${wanted.toFixed(2)}s ±${slack}`)
  }

  it('copies an aligned two-piece cut and drops the piece between them', async (t) => {
    const clip = await makeSource('aligned.mp4')
    const out = outPath('aligned-out.mp4')
    const res = await cut.writeSequence({ clipPath: clip, items: keeps([{ startSec: 0, endSec: 20 }, { startSec: 30, endSec: 60 }]), out })

    assert.equal(res.reencoded, false, 'a cut on keyframes should not re-encode')
    assert.equal(res.pieces, 2)
    assert.equal(res.gaps, 0)
    assertDuration(res.durationSec, 50, 0.25, 'aligned cut')
    assertDuration(res.removedSec, 10, 0.25, 'aligned cut, removed')

    const blocks = assertBlocksDropped(await frameHashes(out), [[20 * FPS, 30 * FPS]], 'aligned cut')
    t.diagnostic(`copied: ${res.durationSec}s, ${res.removedSec}s removed, blocks ${JSON.stringify(blocks)}`)

    const probed = await cut.probe(out)
    assert.equal(probed.streams.filter((s) => s.codec_type === 'audio').length, TRACKS, 'every audio track must survive')
    assert.equal(probed.streams.find((s) => s.codec_type === 'video').width, 320)
  })

  it('joins three pieces in order', async (t) => {
    const clip = await makeSource('several.mp4')
    const out = outPath('several-out.mp4')
    const res = await cut.writeSequence({
      clipPath: clip,
      items: keeps([
        { startSec: 0, endSec: 4 },
        { startSec: 12, endSec: 40 },
        { startSec: 46, endSec: 60 },
      ]),
      out,
    })

    assert.equal(res.reencoded, false)
    assert.equal(res.pieces, 3)
    assertDuration(res.removedSec, 14, 0.4, 'three-piece cut, removed')
    assertDuration(res.durationSec, 46, 0.4, 'three-piece cut')

    const blocks = assertBlocksDropped(
      await frameHashes(out),
      [
        [4 * FPS, 12 * FPS],
        [40 * FPS, 46 * FPS],
      ],
      'three-piece cut',
    )
    t.diagnostic(`copied: ${res.durationSec}s, ${res.removedSec}s removed, blocks ${JSON.stringify(blocks)}`)
  })

  it('removes the head of the clip, which is one piece', async (t) => {
    const clip = await makeSource('head.mp4')
    const out = outPath('head-out.mp4')
    const res = await cut.writeSequence({ clipPath: clip, items: keeps([{ startSec: 6, endSec: 60 }]), out })

    assert.equal(res.reencoded, false)
    assert.equal(res.pieces, 1)
    assertDuration(res.durationSec, 54, 0.25, 'head cut')
    // The piece starts at the keyframe on 6s and runs to the end of the clip, so it
    // is the source's own frames from 6s on, exactly: no tail to round.
    assert.deepEqual(await frameHashes(out), sourceHashes.slice(6 * FPS))
    t.diagnostic(`copied: ${res.durationSec}s, frames 0..${6 * FPS - 1} dropped, exact`)
  })

  it('removes the tail of the clip and keeps the video a copy', async (t) => {
    const clip = await makeSource('tail.mp4')
    const out = outPath('tail-out.mp4')
    const res = await cut.writeSequence({ clipPath: clip, items: keeps([{ startSec: 0, endSec: 54 }]), out })

    assert.equal(res.reencoded, false)
    assert.equal(res.pieces, 1)
    assertDuration(res.durationSec, 54, 0.25, 'tail cut')
    const blocks = assertBlocksDropped(await frameHashes(out), [[54 * FPS, 60 * FPS]], 'tail cut')
    t.diagnostic(`copied: ${res.durationSec}s, ${res.removedSec}s removed, blocks ${JSON.stringify(blocks)}`)
  })

  it('re-encodes when a cut point is not on a keyframe, and keeps audio in sync', async (t) => {
    const clip = await makeSource('unaligned.mp4')
    const out = outPath('unaligned-out.mp4')
    const res = await cut.writeSequence({
      clipPath: clip,
      items: keeps([{ startSec: 0, endSec: 20.5 }, { startSec: 30.25, endSec: 60 }]),
      out,
    })

    assert.equal(res.reencoded, true, 'a cut between keyframes must re-encode')
    assert.equal(res.pieces, 2)
    assertDuration(res.durationSec, 50.25, 0.15, 're-encoded cut')
    t.diagnostic(`re-encoded: ${res.durationSec}s, ${res.removedSec}s removed`)

    // A full decode is also the check that the joined file is readable end to end:
    // framemd5 touches every frame of both pieces.
    const hashes = await frameHashes(out)
    assert.ok(Math.abs(hashes.length - 50.25 * FPS) <= 2, `${hashes.length} frames, wanted ${Math.round(50.25 * FPS)}`)

    const probed = await cut.probe(out)
    assert.equal(probed.streams.filter((s) => s.codec_type === 'audio').length, TRACKS)

    const audio = await audioSeconds(out)
    assert.ok(
      Math.abs(audio - res.durationSec) <= 0.25,
      `audio ${audio.toFixed(3)}s vs video ${res.durationSec.toFixed(3)}s: sync drifted`,
    )
  })

  it('holds a gap as black and silence, at the length the timeline showed', async (t) => {
    const clip = await makeSource('lift.mp4')
    const out = outPath('lift-out.mp4')
    // The piece from 20 to 30 was lifted: 10s of footage is gone and 5s of it stays
    // on the timeline as black, so the output is only 5s shorter than the source.
    const res = await cut.writeSequence({
      clipPath: clip,
      items: [keep(1, 0, 20), gap(2, 5), keep(3, 30, 60)],
      out,
    })

    assert.equal(res.reencoded, true, 'a gap has no packets to copy, so it encodes')
    assert.equal(res.pieces, 2)
    assert.equal(res.gaps, 1)
    assertDuration(res.durationSec, 55, 0.3, 'lift')
    assertDuration(res.removedSec, 5, 0.3, 'lift, source minus output')

    const hashes = await frameHashes(out)
    assert.ok(Math.abs(hashes.length - 55 * FPS) <= 3, `${hashes.length} frames, wanted ${Math.round(55 * FPS)}`)

    // The gap is the only black stretch in the file, and it is where the timeline said.
    const bands = await blackBands(out)
    assert.equal(bands.length, 1, `expected one black band, got ${JSON.stringify(bands)}`)
    assertDuration(bands[0][0], 20, 0.2, 'gap starts')
    assertDuration(bands[0][1], 25, 0.2, 'gap ends')

    const probed = await cut.probe(out)
    assert.equal(probed.streams.filter((s) => s.codec_type === 'audio').length, TRACKS)
    const audio = await audioSeconds(out)
    assert.ok(Math.abs(audio - 55) <= 0.3, `audio ${audio.toFixed(3)}s, wanted about 55s`)
    t.diagnostic(`re-encoded with a gap: ${res.durationSec}s, black ${bands[0][0].toFixed(2)}..${bands[0][1].toFixed(2)}`)
  })

  it('scales one track and rebuilds the mix, without touching the video', async (t) => {
    const clip = await makeSource('volume.mp4')
    const out = outPath('volume-out.mp4')
    const res = await cut.writeSequence({
      clipPath: clip,
      items: keeps([{ startSec: 0, endSec: 20 }]),
      out,
      volumes: [{ stream: 1, volume: 0 }],
    })

    assert.equal(res.reencoded, false, 'a volume change is an audio job: the video stays a copy')
    const blocks = assertBlocksDropped(await frameHashes(out), [[20 * FPS, 60 * FPS]], 'volume trim')

    const probed = await cut.probe(out)
    assert.equal(probed.streams.filter((s) => s.codec_type === 'audio').length, TRACKS, 'mix plus one stream per track')

    // Stream 0 is the rebuilt mix: with the track at zero it carries the other one.
    const mix = await meanVolumeDb(out, 0)
    const muted = await meanVolumeDb(out, 1)
    const other = await meanVolumeDb(out, 2)
    assert.ok(muted < -50, `the track at zero should be silent, measured ${muted} dB`)
    assert.ok(mix > -40, `the mix of what is left should be audible, measured ${mix} dB`)
    assert.ok(other > -40, `the untouched track should be audible, measured ${other} dB`)
    t.diagnostic(`copied video ${res.durationSec}s, blocks ${JSON.stringify(blocks)}; mix ${mix} dB, muted ${muted} dB, other ${other} dB`)
  })

  it('applies a partial fader through a copied join as well', async (t) => {
    const clip = await makeSource('volume-two.mp4')
    const out = outPath('volume-two-out.mp4')
    const sourceTrack = await meanVolumeDb(clip, 2)
    const res = await cut.writeSequence({
      clipPath: clip,
      items: keeps([{ startSec: 0, endSec: 20 }, { startSec: 30, endSec: 60 }]),
      out,
      volumes: [{ stream: 2, volume: 0.5 }],
    })

    assert.equal(res.reencoded, false)
    assert.equal(res.pieces, 2)
    assertBlocksDropped(await frameHashes(out), [[20 * FPS, 30 * FPS]], 'volume join')

    const after = await meanVolumeDb(out, 2)
    // Half amplitude is 6 dB down. Generous window: AAC round-trips are not exact.
    assert.ok(
      Math.abs(sourceTrack - after - 6) < 2.5,
      `expected the track about 6 dB down from ${sourceTrack} dB, measured ${after} dB`,
    )
    t.diagnostic(`copied join ${res.durationSec}s; track ${sourceTrack} dB -> ${after} dB`)
  })

  it('keeps audio in sync through a copied join as well', async (t) => {
    const clip = await makeSource('sync.mp4')
    const out = outPath('sync-out.mp4')
    const res = await cut.writeSequence({ clipPath: clip, items: keeps([{ startSec: 0, endSec: 20 }, { startSec: 30, endSec: 60 }]), out })
    assert.equal(res.reencoded, false)
    const audio = await audioSeconds(out)
    assert.ok(
      Math.abs(audio - res.durationSec) <= 0.25,
      `audio ${audio.toFixed(3)}s vs video ${res.durationSec.toFixed(3)}s: sync drifted`,
    )
    t.diagnostic(`copied join: video ${res.durationSec}s, audio ${audio.toFixed(3)}s`)
  })

  it('spots a copied piece whose packets did not line up', async (t) => {
    // What the packets give when a piece is asked to stop on the frame itself: the
    // encoder wrote the frame after the boundary before the ones in between, so the
    // copy keeps one frame of the removed range and jumps over the rest. This is the
    // cut the pullback exists to avoid and the check exists to catch.
    const raw = path.join(work, 'raw-piece.mp4')
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', '0', '-t', '20', '-i', source, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', raw], { maxBuffer: 1 << 28 })
    assert.equal(await cut.copiedFramesRunEven(raw), false, 'a broken piece must not pass the check')

    const pulled = path.join(work, 'pulled-piece.mp4')
    const len = (20 - 2 / FPS).toFixed(3)
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', '0', '-t', len, '-i', source, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', pulled], { maxBuffer: 1 << 28 })
    assert.equal(await cut.copiedFramesRunEven(pulled), true, 'two frames short should keep the piece whole')
    t.diagnostic(`raw -t 20 broken, -t ${len} whole`)
  })

  it('writes nothing when the edit keeps nothing', async () => {
    const clip = await makeSource('whole.mp4')
    const out = outPath('whole-out.mp4')
    await assert.rejects(() => cut.writeSequence({ clipPath: clip, items: [gap(1, 4)], out }), /nothing left to keep/i)
    await assert.rejects(() => cut.writeSequence({ clipPath: clip, items: [], out }), /nothing left to keep/i)
    assert.equal(fs.existsSync(out), false, 'a refused edit must not leave a file behind')
  })

  it('reports the keyframe positions it cuts on', async () => {
    const keyframes = await cut.probeKeyframes(source)
    assert.ok(keyframes && keyframes.length > 20, 'the source should report roughly one keyframe per 2s')
    // 0, 2, 4, ... : the grid the aligned cases above rely on.
    assert.ok(Math.abs(keyframes[0] - 0) < 0.001)
    assert.ok(Math.abs(keyframes[10] - 20) < 0.05, `keyframe 10 is at ${keyframes[10]}s, expected 20s`)
  })
})
