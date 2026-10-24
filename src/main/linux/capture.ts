import { scope } from '../logger.js'
import { getSetting } from '../store.js'
import { isFullscreen, listMonitors, listWindows, monitorForPoint, x11Display } from './x11.js'
import type { LinuxMonitor, X11Window } from './x11.js'
import type { CaptureTarget } from './recorder.js'
import type { LinuxReplayBuffer } from './replay.js'
import type { CaptureMode, MonitorInfo } from '@shared/types.js'

const log = scope('Capture')

/**
 * Source selection for the Linux backend.
 *
 * Mirrors the Windows manager's public surface, but a source switch is a restart
 * of the recorder rather than an OBS scene edit: there is one capture process and
 * it reads the geometry it was started with.
 */

interface LinuxEngineLike {
  isInitialized(): boolean
  getConfig(): { outputPath: string }
}

export class LinuxCaptureManager {
  currentMonitor = 0
  currentWindowId: string | null = null
  captureMode: CaptureMode = 'display'

  obsMonitors: LinuxMonitor[] = []
  obsWindows: { value: string; name: string }[] = []

  replayBuffer: LinuxReplayBuffer | null = null
  gameDetector: any = null
  onRecordingFinished: ((file: string) => void) | null = null

  private paused = false
  private windowListProbed = false
  private lastWindowListProbeAt = 0
  private lock: Promise<unknown> = Promise.resolve()
  private target: CaptureTarget | null = null
  private gameProcess = ''
  private currentWindowName = ''

  constructor(private readonly engine: LinuxEngineLike) {}

  setReplayBuffer(rb: LinuxReplayBuffer): void {
    this.replayBuffer = rb
  }

  setGameDetector(gd: any): void {
    this.gameDetector = gd
  }

  acquireSourceLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  setupScene(): void {
    this.obsMonitors = listMonitors()
    this.target = this.buildMonitorTarget(0)
    log.info(`Display capture configured (monitor 0, ${this.target.width}x${this.target.height})`)
  }

  getTarget(): CaptureTarget {
    if (!this.target) {
      this.obsMonitors = listMonitors()
      this.target = this.buildMonitorTarget(this.currentMonitor)
    }
    return this.target
  }

  private buildMonitorTarget(index: number): Extract<CaptureTarget, { kind: 'display' }> {
    const monitors = this.obsMonitors.length ? this.obsMonitors : listMonitors()
    const m = monitors[index] ?? monitors[0]
    if (!m) throw new Error('No display available')
    return {
      kind: 'display',
      display: x11Display(),
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
    }
  }

  private buildWindowTarget(win: X11Window): Extract<CaptureTarget, { kind: 'window' }> {
    return {
      kind: 'window',
      display: x11Display(),
      windowId: win.id,
      width: win.width,
      height: win.height,
    }
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  getMonitors(): MonitorInfo[] {
    this.obsMonitors = listMonitors()
    return this.obsMonitors.map((m, i) => ({
      id: String(m.displayId),
      name: this.getDisplayName(i),
      width: m.width,
      height: m.height,
      isPrimary: m.isPrimary,
    }))
  }

  getDisplayName(index: number): string {
    const m = (this.obsMonitors.length ? this.obsMonitors : listMonitors())[index]
    return m?.label || `Display ${index + 1}`
  }

  primaryMonitorIndex(): number {
    const monitors = this.obsMonitors.length ? this.obsMonitors : listMonitors()
    const i = monitors.findIndex((m) => m.isPrimary)
    return i >= 0 ? i : 0
  }

  refreshWindowList(): { value: string; name: string }[] {
    // wmctrl is asynchronous; this method is the synchronous contract the IPC
    // layer wants. The cache is filled by refreshWindowListAsync at startup and on
    // every source switch; a first call before it completes returns the last list.
    this.windowListProbed = true
    this.lastWindowListProbeAt = Date.now()
    void this.refreshWindowListAsync()
    return this.obsWindows
  }

  async refreshWindowListAsync(): Promise<{ value: string; name: string }[]> {
    const windows = await listWindows()
    this.obsWindows = windows
      .filter((w) => w.title && w.width >= 160 && w.height >= 120)
      .map((w) => ({ value: w.id, name: w.title }))
    this.windowListProbed = true
    this.lastWindowListProbeAt = Date.now()
    return this.obsWindows
  }

  refreshWindowListIfStale(): { value: string; name: string }[] {
    if (!this.windowListProbed || Date.now() - this.lastWindowListProbeAt > 5000) return this.refreshWindowList()
    return this.obsWindows
  }

  isWindowListProbed(): boolean {
    return this.windowListProbed
  }

  getCaptureMode(): CaptureMode {
    return this.captureMode
  }

  getCurrentSourceName(): string {
    if (this.captureMode === 'game' && this.gameProcess) return this.gameProcess
    if (this.captureMode === 'window') return this.currentWindowName || 'Window'
    const m = this.obsMonitors[this.currentMonitor]
    return m?.label || `Display ${this.currentMonitor + 1}`
  }

  getCurrentMonitor(): number {
    return this.currentMonitor
  }

  monitorIndexForRect(rect: Electron.Rectangle): number {
    const m = monitorForPoint(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2))
    const i = (this.obsMonitors.length ? this.obsMonitors : listMonitors()).findIndex((x) => x.displayId === m.displayId)
    return i >= 0 ? i : this.primaryMonitorIndex()
  }

  // -------------------------------------------------------------------------
  // Source operations
  // -------------------------------------------------------------------------

  private assertReady(): void {
    if (!this.engine.isInitialized()) throw new Error('Capture engine is not initialized')
  }

  private async switchCaptureSource(target: CaptureTarget, mode: CaptureMode, window?: X11Window): Promise<void> {
    this.assertReady()
    const wasActive = this.replayBuffer?.isReplayBufferActive() ?? false
    let finished: string | null = null

    if (wasActive) {
      await this.replayBuffer!.stopReplayBuffer(true)
      finished = this.replayBuffer!.takeFinishedOnTeardown()
    }

    const previous = { target: this.target, mode: this.captureMode, window: this.currentWindowName, monitor: this.currentMonitor }

    this.target = target
    this.captureMode = mode
    if (window) {
      this.currentWindowName = window.title
      this.currentMonitor = this.monitorIndexForRect({ x: window.x, y: window.y, width: window.width, height: window.height })
    }

    // While paused there is nothing to capture for; the target is remembered and
    // installed by resumeCapture.
    if (this.paused) {
      log.info('Capture is paused; the source change applies on resume')
      return
    }

    try {
      await this.replayBuffer?.startReplayBuffer(true)
    } catch (e) {
      // A source that cannot be opened must not leave the buffer dead. Put the
      // previous source back and start that, then report the failure.
      log.error('Failed to start capture with the new source; restoring the previous one:', e)
      this.target = previous.target
      this.captureMode = previous.mode
      this.currentWindowName = previous.window
      this.currentMonitor = previous.monitor
      try {
        await this.replayBuffer?.startReplayBuffer(true)
      } catch (restoreError) {
        log.error('Could not restart capture on the previous source either:', restoreError)
      }
      throw e
    }
    if (finished) this.onRecordingFinished?.(finished)
  }

  async setMonitor(index: number): Promise<void> {
    await this.acquireSourceLock(async () => {
      this.obsMonitors = listMonitors()
      const target = this.buildMonitorTarget(index)
      await this.switchCaptureSource(target, this.captureMode === 'game' ? 'game' : 'display')
      this.currentMonitor = index
      this.currentWindowId = null
      log.info(`Switched to monitor ${index} (${target.width}x${target.height})`)
    })
  }

  async setWindow(windowId: string): Promise<void> {
    await this.acquireSourceLock(async () => {
      const win = await this.findWindow(windowId)
      if (!win) throw new Error('That window is no longer open')
      await this.switchCaptureSource(this.buildWindowTarget(win), 'window', win)
      this.currentWindowId = windowId
      this.windowListProbed = false
      log.info(`Switched to window capture: ${win.title}`)
    })
  }

  private async findWindow(id: string): Promise<X11Window | null> {
    const wanted = Number.parseInt(id, 16)
    if (!Number.isFinite(wanted)) return null
    return (await listWindows()).find((w) => Number.parseInt(w.id, 16) === wanted) ?? null
  }

  async autoDetectSwitchToWindow(windowId: string, bounds: Electron.Rectangle, processName = ''): Promise<void> {
    await this.acquireSourceLock(async () => {
      const index = this.monitorIndexForRect(bounds)
      this.gameProcess = processName
      await this.switchCaptureSource(this.buildMonitorTarget(index), 'game')
      this.currentMonitor = index
    })
  }

  async autoDetectSwitchToDisplay(index: number): Promise<void> {
    await this.acquireSourceLock(async () => {
      this.gameProcess = this.gameProcess || ''
      const current = this.target
      const monitor = this.buildMonitorTarget(index)
      if (
        this.captureMode === 'game' &&
        current !== null &&
        current.kind === 'display' &&
        current.x === monitor.x &&
        current.y === monitor.y &&
        current.width === monitor.width &&
        current.height === monitor.height
      ) {
        return
      }
      await this.switchCaptureSource(monitor, 'game')
      this.currentMonitor = index
      log.info(`Auto-detect mode: switched to ${this.getDisplayName(index)}`)
    })
  }

  async setAutoDetectCapture(displayIndex: number): Promise<void> {
    this.assertReady()
    await this.autoDetectSwitchToDisplay(displayIndex)
    this.gameDetector?.setFallbackDisplayIndex?.(displayIndex)
    this.gameDetector?.start?.()
  }

  /** Name shown for a game the detector has locked onto. */
  setGameProcess(name: string): void {
    this.gameProcess = name
  }

  stopGameDetector(): void {
    if (this.gameDetector?.isRunning?.()) {
      this.gameDetector.stop()
      log.info('Game detector stopped')
    }
  }

  isOnHookFallback(): boolean {
    return false
  }

  async pauseCapture(): Promise<void> {
    this.paused = true
    this.stopGameDetector()
    log.info('Capture stopped (buffer paused)')
  }

  async resumeCapture(): Promise<void> {
    this.assertReady()
    this.paused = false

    const mode = getSetting('captureMode')
    const displayIndex = getSetting('displayIndex')
    const windowId = getSetting('windowId')

    if (mode === 'game') {
      await this.setAutoDetectCapture(displayIndex)
      return
    }
    if (mode === 'window' && windowId) {
      try {
        await this.setWindow(windowId)
        return
      } catch {
        log.warn('Failed to restore window capture, falling back to display')
      }
    }
    await this.setMonitor(displayIndex)
  }

  isCapturePaused(): boolean {
    return this.paused
  }

  // -------------------------------------------------------------------------
  // Display changes
  // -------------------------------------------------------------------------

  async applyDisplayChange(): Promise<{ from: string; to: string } | null> {
    if (!this.engine.isInitialized()) return null
    if (this.paused) return null
    if (this.captureMode === 'window') return null

    const before = this.target?.kind === 'display' ? this.target : null
    const monitors = listMonitors()
    this.obsMonitors = monitors
    const m = monitors[this.currentMonitor] ?? monitors[0]
    if (!m) return null

    if (before && before.x === m.x && before.y === m.y && before.width === m.width && before.height === m.height) {
      return null
    }

    const from = before ? `${before.width}x${before.height}` : '(unknown)'
    const to = `${m.width}x${m.height}`
    const wasActive = this.replayBuffer?.isReplayBufferActive() ?? false

    await this.acquireSourceLock(async () => {
      if (wasActive) {
        await this.replayBuffer?.stopReplayBuffer(true)
        const finished = this.replayBuffer?.takeFinishedOnTeardown() ?? null
        if (finished) this.onRecordingFinished?.(finished)
      }
      this.target = this.buildMonitorTarget(this.currentMonitor)
      if (!this.paused) await this.replayBuffer?.startReplayBuffer(true)
    })

    log.info(`Capture canvas synced to the display: ${from} -> ${to}`)
    return { from, to }
  }

  refreshCanvasForDisplay(): { width: number; height: number } | null {
    this.obsMonitors = listMonitors()
    const m = this.obsMonitors[this.currentMonitor] ?? this.obsMonitors[0]
    return m ? { width: m.width, height: m.height } : null
  }

  onSourceSizes(_sources: { name: string; width: number; height: number }[]): void {}

  releaseScene(): void {
    this.stopGameDetector()
  }

  /** The detector reports the foreground window here. */
  async detectGameWindow(win: X11Window): Promise<void> {
    if (!isFullscreen(win)) return
    const index = this.monitorIndexForRect({ x: win.x, y: win.y, width: win.width, height: win.height })
    if (this.captureMode !== 'game' || this.currentMonitor !== index || this.gameProcess !== win.process) {
      this.gameProcess = win.process
      await this.autoDetectSwitchToDisplay(index)
    }
  }
}
