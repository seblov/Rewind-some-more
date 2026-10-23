/**
 * The clip as a sequence of pieces: the cut, delete and lift rules, with no I/O.
 *
 * Kept apart from the ffmpeg work (main/cut.ts) because these are the rules worth
 * testing and worth drawing: which piece a cut lands in, what a delete closes up,
 * what a lift leaves behind, and where each piece falls on the output timeline.
 * The editor draws the same list the writer runs from, so the timeline and the
 * file can never disagree about what the user removed.
 */

/** A span of the clip, in seconds from its start. */
export interface CutRange {
  startSec: number
  endSec: number
}

/**
 * The shortest piece a cut can leave behind.
 *
 * A cut that would produce a sliver is refused rather than snapped: a piece a few
 * frames long is not watchable, and quietly moving the cut point would make the
 * file disagree with the playhead the user placed.
 */
export const MIN_SEGMENT_SEC = 0.1

/** A piece of the source the output keeps. */
export interface Keep {
  id: number
  kind: 'keep'
  srcIn: number
  srcOut: number
}

/** A stretch of black and silence the output holds, as long as the piece it replaced. */
export interface Gap {
  id: number
  kind: 'gap'
  durSec: number
}

/** One step of the sequence: a kept piece, or a gap where a piece was lifted out. */
export type Item = Keep | Gap

/** An item placed on the output timeline. */
export interface Span {
  item: Item
  outIn: number
  outOut: number
}

export interface Layout {
  spans: Span[]
  /** Length of the output: the pieces and gaps joined in order. */
  duration: number
  /** The kept pieces, in source time and in output order. */
  kept: CutRange[]
  /** Gap lengths, in output order. */
  gaps: number[]
}

/** Where a cut at the given output time would land, or why it cannot. */
export type CutTarget = { index: number } | { error: string }

/** Places the items end to end and reports where each one falls. */
export function layout(items: Item[]): Layout {
  const spans: Span[] = []
  const kept: CutRange[] = []
  const gaps: number[] = []
  let out = 0
  for (const item of items) {
    const length = item.kind === 'keep' ? item.srcOut - item.srcIn : item.durSec
    spans.push({ item, outIn: out, outOut: out + length })
    if (item.kind === 'keep') kept.push({ startSec: item.srcIn, endSec: item.srcOut })
    else gaps.push(item.durSec)
    out += length
  }
  return { spans, duration: out, kept, gaps }
}

/** The span under an output time. Null past the end of the sequence. */
export function spanAtOut(spans: Span[], outT: number): Span | null {
  for (const span of spans) {
    if (outT >= span.outIn && outT < span.outOut) return span
  }
  return null
}

/** The source time an output time points at. Null over a gap. */
export function srcAt(spans: Span[], outT: number): number | null {
  const span = spanAtOut(spans, outT)
  if (!span || span.item.kind === 'gap') return null
  return span.item.srcIn + (outT - span.outIn)
}

/** Where a source time falls in the output. Null when it is inside removed footage. */
export function outAt(spans: Span[], srcT: number): number | null {
  for (const span of spans) {
    if (span.item.kind !== 'keep') continue
    if (srcT >= span.item.srcIn && srcT < span.item.srcOut) return span.outIn + (srcT - span.item.srcIn)
  }
  return null
}

/** Rounds to the nearest frame. An unknown frame rate leaves the time alone. */
export function snapToFrame(seconds: number, fps: number): number {
  return fps > 0 ? Math.round(seconds * fps) / fps : seconds
}

/**
 * Where a cut at this output time would land, or why it cannot.
 *
 * A cut refuses rather than repairs: within a tenth of a second of a piece's edge
 * there is no room for a piece, and over a gap there is no footage to cut. Both
 * refusals are drawn on the button, so the rule is never a surprise.
 */
export function cutTarget(items: Item[], outT: number, fps: number): CutTarget {
  const { spans } = layout(items)
  const span = spanAtOut(spans, outT)
  if (!span || span.item.kind === 'gap') return { error: 'No clip here' }
  const item = span.item
  const at = snapToFrame(item.srcIn + (outT - span.outIn), fps)
  if (at - item.srcIn < MIN_SEGMENT_SEC || item.srcOut - at < MIN_SEGMENT_SEC) {
    return { error: 'Already cut here' }
  }
  return { index: spans.indexOf(span) }
}

/** Splits the piece under this output time in two. Throws with the reason it cannot. */
export function cutAt(items: Item[], outT: number, fps: number, nextId: () => number): Item[] {
  const target = cutTarget(items, outT, fps)
  if ('error' in target) throw new Error(target.error)
  const { spans } = layout(items)
  const piece = spans[target.index].item as Keep
  const at = snapToFrame(piece.srcIn + (outT - spans[target.index].outIn), fps)
  return [
    ...items.slice(0, target.index),
    { id: nextId(), kind: 'keep', srcIn: piece.srcIn, srcOut: at },
    { id: nextId(), kind: 'keep', srcIn: at, srcOut: piece.srcOut },
    ...items.slice(target.index + 1),
  ]
}

/**
 * Removes the selected items.
 *
 * `ripple` drops them and the sequence closes up. `lift` replaces a piece with a
 * gap of the same length, which keeps its id: the gap is that step of the sequence,
 * so the selection a redo restores still points at something.
 */
export function deleteItems(items: Item[], ids: number[], mode: 'ripple' | 'lift'): Item[] {
  const kill = new Set(ids)
  return items.flatMap((item) => {
    if (!kill.has(item.id)) return [item]
    if (mode === 'lift' && item.kind === 'keep') {
      return [{ id: item.id, kind: 'gap' as const, durSec: item.srcOut - item.srcIn }]
    }
    return []
  })
}

/**
 * Removes the stretch between two output times and closes the sequence up.
 *
 * A range may start or end inside a piece, so both edges are split and the middle
 * is dropped. The sliver rule applies at the edges: a surviving side shorter than
 * {@link MIN_SEGMENT_SEC} is dropped with the range rather than written as a piece
 * too short to watch, which can take a fraction of a frame more than was marked.
 */
export function removeRange(items: Item[], fromOut: number, toOut: number, fps: number, nextId: () => number): Item[] {
  const from = snapToFrame(Math.min(fromOut, toOut), fps)
  const to = snapToFrame(Math.max(fromOut, toOut), fps)
  const out: Item[] = []
  for (const span of layout(items).spans) {
    const { item } = span
    const overlapIn = Math.max(span.outIn, from)
    const overlapOut = Math.min(span.outOut, to)
    if (overlapOut <= overlapIn) {
      out.push(item)
      continue
    }
    const head = overlapIn - span.outIn
    const tail = span.outOut - overlapOut
    if (item.kind === 'gap') {
      if (head >= MIN_SEGMENT_SEC) out.push({ id: nextId(), kind: 'gap', durSec: head })
      if (tail >= MIN_SEGMENT_SEC) out.push({ id: nextId(), kind: 'gap', durSec: tail })
    } else {
      if (head >= MIN_SEGMENT_SEC) out.push({ id: nextId(), kind: 'keep', srcIn: item.srcIn, srcOut: item.srcIn + head })
      if (tail >= MIN_SEGMENT_SEC) out.push({ id: nextId(), kind: 'keep', srcIn: item.srcOut - tail, srcOut: item.srcOut })
    }
  }
  return out
}

/** Seconds the sequence keeps. */
export function keptSec(items: Item[]): number {
  return items.reduce((total, item) => (item.kind === 'keep' ? total + (item.srcOut - item.srcIn) : total), 0)
}

/** The rule the save buttons and the writer both run, so they can never disagree. */
export function canSave(items: Item[]): { ok: true } | { ok: false; error: string } {
  if (!items.some((item) => item.kind === 'keep')) return { ok: false, error: 'Nothing left to keep' }
  if (keptSec(items) < 1) return { ok: false, error: 'Less than a second left to save' }
  return { ok: true }
}

/**
 * Cuts the waveform to match the sequence.
 *
 * One bar per bucket of source time, so a kept piece keeps its own shape and a gap
 * is left empty: a gap plays silence, and drawing the removed audio there would be
 * a lie about what the file holds.
 */
export function splicePeaks(peaks: number[], srcDurationSec: number, items: Item[]): number[] {
  if (!peaks.length || !(srcDurationSec > 0)) return []
  const perSec = peaks.length / srcDurationSec
  const out: number[] = []
  for (const item of items) {
    if (item.kind === 'gap') {
      out.push(...new Array<number>(Math.max(1, Math.round(item.durSec * perSec))).fill(0))
      continue
    }
    const from = Math.max(0, Math.round(item.srcIn * perSec))
    const to = Math.min(peaks.length, Math.round(item.srcOut * perSec))
    for (let i = from; i < to; i++) out.push(peaks[i] ?? 0)
  }
  return out
}

/** `HH:MM:SS:FF` at a known frame rate, `HH:MM:SS.mmm` without one. */
export function formatTimecode(seconds: number, fps: number): string {
  const t = Math.max(0, seconds)
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  if (fps > 0) {
    // Rounding up can reach the next frame's number; an NLE shows the last one.
    const frames = Math.min(Math.round((t - Math.floor(t)) * fps), Math.max(0, Math.round(fps) - 1))
    return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`
  }
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(Math.floor((t % 1) * 1000)).padStart(3, '0')}`
}

/** Seconds from `HH:MM:SS.ms`, `MM:SS.ms`, `SS.ms`, or a plain number. NaN when unreadable. */
export function parseTimecode(value: number | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const parts = String(value ?? '').trim().split(':')
  if (parts.length === 0 || parts.length > 3) return NaN
  let total = 0
  for (const part of parts) {
    // Digits only: no sign and no unit suffix, so `-2` and `90s` are refused here
    // and reported to the user rather than quietly becoming a number.
    if (!/^\d+(\.\d+)?$/.test(part)) return NaN
    total = total * 60 + Number(part)
  }
  return total
}
