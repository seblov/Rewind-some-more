// Fetches the Linux capture build of ffmpeg.
//
// ffmpeg-static's Linux binary is built without libpulse, so it cannot read the
// monitor and microphone sources the recorder needs. The BtbN gpl build has
// x11grab, libpulse, x264, VAAPI and NVENC. It is downloaded rather than
// committed: it is ~170MB.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'vendor', 'linux', 'ffmpeg')
const url =
  process.env.REWIND_FFMPEG_URL ||
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'
const force = process.argv.includes('--force')

function verify(binary) {
  const probe = spawnSync(binary, ['-hide_banner', '-devices'], { encoding: 'utf8', timeout: 15000 })
  if (probe.status !== 0) throw new Error(`ffmpeg at ${binary} did not run`)
  const devices = `${probe.stdout}${probe.stderr}`
  return { x11grab: /x11grab/.test(devices), pulse: / pulse /.test(devices) }
}

if (fs.existsSync(target) && !force) {
  const ok = verify(target)
  if (ok.x11grab && ok.pulse) {
    console.log(`[ffmpeg:linux] already installed at ${target}`)
    process.exit(0)
  }
  console.log('[ffmpeg:linux] the installed binary lacks x11grab or pulse; replacing it')
}

if (process.platform !== 'linux') {
  console.error('[ffmpeg:linux] this script only runs on Linux (the Windows build uses ffmpeg-static)')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-ffmpeg-'))
const archive = path.join(tmp, 'ffmpeg.tar.xz')

console.log(`[ffmpeg:linux] downloading ${url}`)
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
const total = Number(response.headers.get('content-length') || 0)
let received = 0
let lastReport = 0
await new Promise(async (resolve, reject) => {
  const out = fs.createWriteStream(archive)
  out.on('error', reject)
  out.on('finish', resolve)
  try {
    for await (const chunk of response.body) {
      received += chunk.length
      out.write(chunk)
      if (received - lastReport > 25 * 1024 * 1024) {
        lastReport = received
        const pct = total ? ` (${Math.round((received / total) * 100)}%)` : ''
        process.stdout.write(`[ffmpeg:linux] ${Math.round(received / 1024 / 1024)} MB${pct}\n`)
      }
    }
    out.end()
  } catch (e) {
    out.destroy()
    reject(e)
  }
})

const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', timeout: 120000 })
if (listing.status !== 0) throw new Error(`could not read the archive: ${listing.stderr}`)
const entry = listing.stdout
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.endsWith('/bin/ffmpeg'))
if (!entry) throw new Error('the archive has no bin/ffmpeg')

console.log(`[ffmpeg:linux] extracting ${entry}`)
const extractDir = path.join(tmp, 'extract')
fs.mkdirSync(extractDir, { recursive: true })
const extracted = spawnSync('tar', ['-xJf', archive, '-C', extractDir, entry], { timeout: 300000 })
if (extracted.status !== 0) throw new Error(`could not extract ffmpeg: ${extracted.stderr}`)

const source = path.join(extractDir, entry)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(source, target)
fs.chmodSync(target, 0o755)

const ok = verify(target)
if (!ok.x11grab || !ok.pulse) {
  throw new Error(`the downloaded binary is missing x11grab (${ok.x11grab}) or pulse (${ok.pulse})`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`[ffmpeg:linux] installed ${target}`)
