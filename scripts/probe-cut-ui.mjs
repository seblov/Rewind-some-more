/**
 * Drives the split/cut-out flow in the editor window: split, a second split refused on the
 * seam, ripple delete, undo, a lift, and a real save.
 *
 * Run against the app on --remote-debugging-port=9222:
 *   node scripts/probe-cut-ui.mjs
 *
 * Writes one `-edit` copy beside the clip it opened, and a screenshot of the sequence
 * with a gap in it under the temp folder.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect } from './cdp.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/**
 * In-page helpers, wrapped in a function so each evaluate is self-contained: a bare
 * `const` at the top level of an evaluate would live on in the page and collide with
 * the next one.
 */
const HELPERS = `
  const $$ = (sel) => [...document.querySelectorAll(sel)]
  const pieces = () => $$('[data-testid="timeline-piece"]').length
  const gapBlocks = () => $$('[data-testid="timeline-gap"]').length
  const lane = () => document.querySelector('div[role="slider"][aria-label="Playhead"]')
  const buttonByText = (t) => $$('button').find((b) => b.textContent.trim() === t)
  const totalLabel = () => ($$('span').find((s) => s.textContent.trim().startsWith('/ ')) || {}).textContent
  const timecode = () => document.querySelector('[aria-label="Playhead timecode"]').value
  const clickLaneAt = (frac) => {
    const el = lane(); const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * frac, clientY: r.top + r.height / 2 }))
  }
  const clickBlock = (i) => $$('[data-testid="timeline-piece"], [data-testid="timeline-gap"]')[i].click()
  const key = (code, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...opts }))
`

// A leftover editor window from an earlier run would be driven instead of a fresh one.
for (const t of await (await fetch('http://127.0.0.1:9222/json/list')).json()) {
  if ((t.url || '').includes('editor=1')) await fetch('http://127.0.0.1:9222/json/close/' + t.id)
}
await wait(1000)

const panel = await connect()
const clip = await panel.evaluate(
  `window.electronAPI.getSavedClips().then(r => r.success && r.data.length ? (r.data.find(c => !c.path.includes('-edit')) || r.data[0]).path : null)`,
)
if (!clip) throw new Error('no clips in the library')
console.log('clip:', clip)

const before = await panel.evaluate(`window.electronAPI.getSavedClips().then(r => r.data.length)`)
await panel.evaluate(`window.electronAPI.openClipEditor(${JSON.stringify(clip)}).then(r => r.success)`)

let editor = null
for (let i = 0; i < 40 && !editor; i++) {
  await wait(500)
  try {
    // connect() falls back to the panel when the filter matches nothing, so the URL
    // decides whether the editor is really up.
    const candidate = await connect('editor=1')
    if (candidate.url.includes('editor=1')) editor = candidate
    else candidate.close()
  } catch {
    /* not open yet */
  }
}
if (!editor) throw new Error('the editor window never opened')
await wait(3000)

const run = (expr) => editor.evaluate(`(() => {\n${HELPERS}\nreturn (${expr})\n})()`)

const opened = await run(`({ pieces: pieces(), gaps: gapBlocks(), total: totalLabel() })`)
check('the editor opens on one whole piece', opened.pieces === 1 && opened.gaps === 0, JSON.stringify(opened))

// 1. Split at 40%. The playhead must land on a real seam and split the piece in two.
await run(`clickLaneAt(0.4)`)
const at = await run(`timecode()`)
await run(`key('KeyC')`)
await wait(300)
const cut = await run(`({ pieces: pieces(), gaps: gapBlocks(), total: totalLabel() })`)
check('C splits the piece at the playhead', cut.pieces === 2 && cut.gaps === 0, `${at} -> ${JSON.stringify(cut)}`)
check('a cut does not change the length', cut.total === opened.total, `${opened.total} vs ${cut.total}`)

// 2. A second split on the same seam is refused, with the reason shown.
await run(`key('KeyC')`)
await wait(300)
const again = await run(`({ pieces: pieces(), notice: document.body.innerText.includes('Already cut here') })`)
check('a cut on its own seam is refused, not snapped', again.pieces === 2, JSON.stringify(again))
check('the refusal is shown on screen', again.notice === true)

// 3. Select the second piece and cut it out: the sequence closes up.
await run(`clickBlock(1)`)
const armed = await run(`buttonByText('Cut out').disabled === false && buttonByText('Lift').disabled === false`)
check('selecting a piece arms Cut out and Lift', armed === true)
await run(`key('Delete')`)
await wait(300)
const removed = await run(`({ pieces: pieces(), gaps: gapBlocks(), total: totalLabel() })`)
check('Delete removes the piece and closes the gap', removed.pieces === 1 && removed.gaps === 0, JSON.stringify(removed))
check('a ripple delete shortens the sequence', removed.total !== cut.total, `${cut.total} -> ${removed.total}`)

// 4. Undo brings the piece back; Shift+Delete lifts it instead and keeps the length.
await run(`key('KeyZ', { ctrlKey: true })`)
await wait(300)
const undone = await run(`({ pieces: pieces(), gaps: gapBlocks(), total: totalLabel() })`)
check('undo restores the deleted piece', undone.pieces === 2 && undone.gaps === 0, JSON.stringify(undone))

await run(`clickBlock(1)`)
await run(`key('Delete', { shiftKey: true })`)
await wait(300)
const lifted = await run(`({ pieces: pieces(), gaps: gapBlocks(), total: totalLabel() })`)
check('Shift+Delete leaves a gap block', lifted.pieces === 1 && lifted.gaps === 1, JSON.stringify(lifted))
check('a lift keeps the length', lifted.total === cut.total, `${cut.total} vs ${lifted.total}`)

const shot = await editor.send('Page.captureScreenshot', { format: 'png' })
const shotFile = path.join(os.tmpdir(), 'opencode', 'rewind-cut-ui.png')
fs.mkdirSync(path.dirname(shotFile), { recursive: true })
fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'))
console.log('screenshot:', shotFile)

// 6. Playback stops at the seam and wraps to the top instead of running past the end
//    of the sequence. Without the guard the element would keep playing into footage
//    the edit no longer holds, and `video.currentTime` would sail past the piece.
await run(`buttonByText('Reset').click()`)
await wait(300)
await run(`clickLaneAt(0.3)`)
await run(`key('KeyC')`)
await run(`clickBlock(1)`)
await run(`key('Delete')`)
await wait(300)
const short = await run(`({ pieces: pieces(), gaps: gapBlocks() })`)
check('Reset then a cut and a delete leave one short piece', short.pieces === 1 && short.gaps === 0, JSON.stringify(short))

await run(`clickLaneAt(0.263)`) // about 4.5s of source time, just before the new end
const beforePlay = await run(`timecode()`)
await run(`key('Space')`)
await wait(1500)
const played = await run(
  `({ t: timecode(), source: document.querySelector('video').currentTime, playing: !document.querySelector('video').paused })`,
)
check(
  'playback wraps at the end of the sequence',
  played.playing === true && played.source < 5.2,
  `${beforePlay} -> ${played.t}, source ${played.source.toFixed(2)}s`,
)
await run(`key('Space')`)
await wait(200)

// 7. A gap is held black: the picture stops, the playhead crosses, the overlay is up.
await run(`buttonByText('Reset').click()`)
await wait(300)
await run(`clickLaneAt(0.3)`)
await run(`key('KeyC')`)
await run(`clickBlock(1)`)
await run(`key('Delete', { shiftKey: true })`)
await wait(300)
await run(`clickLaneAt(0.25)`) // about 4.3s of source time, inside the piece
const beforeGap = await run(`timecode()`)
await run(`key('Space')`)
await wait(2000)
const held = await run(
  `({ t: timecode(), stopped: document.querySelector('video').paused, black: !!document.querySelector('div.pointer-events-none.absolute.inset-0.bg-black') })`,
)
check('playback crosses a gap with the picture held', held.t > '00:00:05:10' && held.stopped === true, `${beforeGap} -> ${held.t}, paused ${held.stopped}`)
check('the preview goes black over a gap', held.black === true)
await run(`key('Space')`)
await wait(200)

// 5. Save a copy: the real writer runs, and the library gains the file it wrote.
await run(`buttonByText('Save a copy').click()`)
let after = before
for (let i = 0; i < 60 && after === before; i++) {
  await wait(1000)
  after = await panel.evaluate(`window.electronAPI.getSavedClips().then(r => r.success ? r.data.length : -1)`)
}
const saved = await panel.evaluate(
  `window.electronAPI.getSavedClips().then(r => r.data.filter(c => c.path.includes('-edit')).map(c => c.path).join('\\n'))`,
)
check('Save a copy writes a new file into the library', after === before + 1, `${before} -> ${after} clips`)
console.log('edited files:\n' + saved)

const errs = editor.drainErrors().concat(panel.drainErrors())
check('no renderer exceptions', errs.length === 0, errs.join(' | '))

editor.close()
panel.close()

const failed = results.filter((r) => !r)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
