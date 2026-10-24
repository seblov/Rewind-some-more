import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * X11 display and window facts.
 *
 * The Linux capture backend needs two things the Windows one gets from OBS: a
 * monitor list in the same pixel space x11grab draws from, and the X11 window ids
 * the window picker shows. Both come from the X server here, with Electron owning
 * the monitor list so the UI and the capture region agree.
 */

export interface LinuxMonitor {
  index: number
  /** X11 pixel origin. */
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
  isPrimary: boolean
  label: string
  displayId: number
}

export interface X11Window {
  /** X11 window id, as `0x...`. */
  id: string
  pid: number
  title: string
  process: string
  x: number
  y: number
  width: number
  height: number
}

export function onX11(): boolean {
  return process.platform === 'linux' && !!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

/** x11grab needs the screen suffix (`:0.0`); DISPLAY is often just `:0`. */
export function x11Display(): string {
  const display = process.env.DISPLAY || ':0'
  return /:\d+\.\d+$/.test(display) ? display : `${display}.0`
}

/**
 * Electron's screen module is required lazily.
 *
 * `ffmpeg.ts` is bundled by small test harnesses that stub `electron` with only the
 * one or two members they need; importing `screen` at module scope made those
 * builds fail even when the screenshot path was never reached.
 */
function screens(): typeof import('electron').screen {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('electron') as typeof import('electron')).screen
}

export function listMonitors(): LinuxMonitor[] {
  const screen = screens()
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, index) => {
    const scale = d.scaleFactor || 1
    return {
      index,
      x: Math.round(d.bounds.x * scale),
      y: Math.round(d.bounds.y * scale),
      width: Math.round(d.bounds.width * scale),
      height: Math.round(d.bounds.height * scale),
      scaleFactor: scale,
      isPrimary: d.id === primaryId,
      label: d.label || `Display ${index + 1}`,
      displayId: d.id,
    }
  })
}

export function monitorForPoint(x: number, y: number): LinuxMonitor {
  const monitors = listMonitors()
  const hit = monitors.find((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
  return hit ?? monitors.find((m) => m.isPrimary) ?? monitors[0]
}

export function monitorForWindow(win: { x: number; y: number; width: number; height: number }): LinuxMonitor {
  return monitorForPoint(Math.round(win.x + win.width / 2), Math.round(win.y + win.height / 2))
}

const WINDOW_LINE = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/i

/** Processes whose windows are never capture targets: shells, panels and us. */
const NEVER_CAPTURE = new Set([
  'gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'mutter', 'xfwm4',
  'openbox', 'i3', 'sway', 'wayfire', 'picom', 'compton',
])

export function processName(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase()
  } catch {
    return ''
  }
}

/** Windows in stacking order, newest last. Empty when wmctrl is unavailable. */
export async function listWindows(): Promise<X11Window[]> {
  let stdout: string
  try {
    stdout = (await execFileP('wmctrl', ['-lpG'], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 })).stdout
  } catch {
    return []
  }

  const ownPid = process.pid
  const out: X11Window[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = WINDOW_LINE.exec(line.trim())
    if (!m) continue

    const pid = Number(m[3])
    if (!pid || pid === ownPid) continue

    const process = processName(pid)
    if (!process || NEVER_CAPTURE.has(process)) continue
    // Electron's helper processes share the app's windows; the main pid filter
    // already drops our own, but a detached child would still slip through.
    if (process === 'electron' && pid !== ownPid) {
      // Other Electron apps are legitimate targets, so keep them unless their
      // window is one of Rewind's own titles.
      const title = m[9] ?? ''
      if (/^rewind\b/i.test(title)) continue
    }

    out.push({
      id: m[1].toLowerCase(),
      pid,
      x: Number(m[4]),
      y: Number(m[5]),
      width: Number(m[6]),
      height: Number(m[7]),
      process,
      title: (m[9] ?? '').trim(),
    })
  }
  return out
}

/** The window with input focus. Null when xprop cannot answer. */
export async function activeWindow(): Promise<X11Window | null> {
  let id: string | null = null
  try {
    const { stdout } = await execFileP('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 3000 })
    const m = /window id # (0x[0-9a-f]+)/i.exec(stdout)
    id = m?.[1]?.toLowerCase() ?? null
  } catch {
    return null
  }
  if (!id || id === '0x0') return null
  const windows = await listWindows()
  // xprop prints `0x5400011`; wmctrl prints `0x05400011`. Compare the values.
  const wanted = Number.parseInt(id, 16)
  return windows.find((w) => Number.parseInt(w.id, 16) === wanted) ?? null
}

export async function windowInfo(id: string): Promise<X11Window | null> {
  const wanted = Number.parseInt(id, 16)
  if (!Number.isFinite(wanted)) return null
  return (await listWindows()).find((w) => Number.parseInt(w.id, 16) === wanted) ?? null
}

/** True when the window covers its monitor, within the window manager's frame. */
export function isFullscreen(win: X11Window): boolean {
  const m = monitorForWindow(win)
  const tolerance = 48
  return (
    win.x <= m.x + tolerance &&
    win.y <= m.y + tolerance &&
    win.width >= m.width - tolerance * 2 &&
    win.height >= m.height - tolerance * 2
  )
}
