import { scope } from '../logger.js'
import { EXCLUDED_PROCESSES } from '../game-detector.js'
import { activeWindow, isFullscreen, monitorForWindow } from './x11.js'
import type { X11Window } from './x11.js'
import { GAME_DETECTOR } from '@shared/constants.js'

const log = scope('GameDetector')

/**
 * Foreground fullscreen detection on X11.
 *
 * There is no game-hook capture on Linux, so "auto detect a launched game" means
 * following the fullscreen window to the monitor it is on and naming the clip
 * after its process. That is the part of the Windows detector the library and
 * the panel actually show.
 */
export class LinuxGameDetector {
  private capture: any = null
  private getMainWindow: () => any = () => null
  private timer: NodeJS.Timeout | null = null
  private running = false
  private candidate: { id: string; process: string; count: number } | null = null
  private active = ''
  private excluded = new Set<string>()
  private fallbackIndex = 0

  setCapture(c: any): void {
    this.capture = c
  }

  setGetMainWindow(fn: () => any): void {
    this.getMainWindow = fn
  }

  setFallbackDisplayIndex(i: number): void {
    this.fallbackIndex = i
  }

  excludeProcess(name: string): void {
    const key = name.trim().toLowerCase()
    if (!key) return
    this.excluded.add(key)
    log.info(`Leaving "${key}" alone for the rest of this session`)
  }

  isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.candidate = null
    this.active = ''
    log.info('Watching for a fullscreen game')
    void this.poll()
    this.timer = setInterval(() => void this.poll(), GAME_DETECTOR.POLL_INTERVAL)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.candidate = null
    log.info('Stopped watching for a game')
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.capture) return
    try {
      const win = await activeWindow()
      if (!win) {
        this.candidate = null
        return
      }
      if (!this.qualifies(win)) {
        this.candidate = null
        return
      }

      const key = `${win.id}:${win.process}`
      if (this.candidate?.id === key) {
        this.candidate.count++
      } else {
        this.candidate = { id: key, process: win.process, count: 1 }
      }
      if (this.candidate.count < GAME_DETECTOR.CANDIDATE_THRESHOLD) return
      if (this.active === key) return

      const monitor = monitorForWindow(win)
      this.active = key
      this.capture.setGameProcess?.(win.process)
      await this.capture.autoDetectSwitchToDisplay?.(monitor.index)
      log.info(`Auto-detect: "${win.process}" is fullscreen on ${monitor.label}`)
    } catch (e) {
      log.warn('Game detection poll failed:', e)
    }
  }

  private qualifies(win: X11Window): boolean {
    if (!win.process || !win.title) return false
    if (win.pid === process.pid) return false
    if (EXCLUDED_PROCESSES.has(win.process) || this.excluded.has(win.process)) return false
    if (!isFullscreen(win)) return false
    // The app's own panel is never a game, even when it fills a monitor.
    const own = this.getMainWindow()
    if (own && !own.isDestroyed()) {
      const bounds = own.getBounds()
      if (Math.abs(bounds.x - win.x) < 4 && Math.abs(bounds.y - win.y) < 4) return false
    }
    return true
  }
}
