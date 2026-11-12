/**
 * Typed metadata read/write helpers over the two JSON stores.
 *
 * These exist so ipc.ts and index.ts share one definition of "merge, don't clobber"
 * when stamping a clip or screenshot.
 */
import { clipMeta, screenshotMeta, type ClipMeta } from './store.js'

/** Merges a patch into a clip's record, defaulting `recordedAt` to now. */
export function setClipMeta(file: string, patch: Partial<ClipMeta>): void {
  const all = clipMeta.get('clips') ?? {}
  // Existing record wins over the "now" default; an explicit patch wins over both.
  const prev = all[file] ?? { recordedAt: Date.now() }
  all[file] = { ...prev, ...patch }
  clipMeta.set('clips', all)
}

export function getClipMeta(file: string): ClipMeta | null {
  return clipMeta.get('clips')?.[file] ?? null
}

/**
 * Drops the record for a path a rename has moved away from.
 *
 * Paths are case-insensitive on disk and exact in the store, so the key is matched
 * the way the library matches one.
 */
export function deleteClipMeta(file: string): void {
  const all = clipMeta.get('clips') ?? {}
  const lower = file.toLowerCase()
  const key = Object.keys(all).find((k) => k.toLowerCase() === lower)
  if (!key) return
  delete all[key]
  clipMeta.set('clips', all)
}

export function setScreenshotMeta(file: string, patch: { capturedAt: number; source?: string }): void {
  const all = screenshotMeta.get('screenshots') ?? {}
  const prev = all[file] ?? { capturedAt: Date.now() }
  all[file] = { ...prev, ...patch }
  screenshotMeta.set('screenshots', all)
}

export function getScreenshotMeta(file: string): { capturedAt: number; source?: string } | null {
  return screenshotMeta.get('screenshots')?.[file] ?? null
}

export function deleteScreenshotMeta(file: string): void {
  const all = screenshotMeta.get('screenshots') ?? {}
  delete all[file]
  screenshotMeta.set('screenshots', all)
}