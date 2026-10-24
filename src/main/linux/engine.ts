import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scope } from '../logger.js'
import { resolveFfmpeg } from '../ffmpeg.js'
import { getSetting } from '../store.js'
import { LinuxCaptureManager } from './capture.js'
import { LinuxReplayBuffer } from './replay.js'
import { LinuxAudioDeviceChannels, LinuxAudioMix, primeLinuxDevices, deviceAvailable, invalidateDeviceCache } from './audio.js'
import { qualityTarget } from './recorder.js'
import type { RecorderStream } from './recorder.js'
import { listMonitors, onX11 } from './x11.js'
import { TRACK } from '@shared/constants.js'
import type { AudioChannel, DeviceKind } from '@shared/types.js'

const log = scope('LinuxEngine')
const execFileP = promisify(execFile)

export interface LinuxConfig {
  bufferDuration: number
  fps: number
  outputPath: string
  outputResolution: 'native' | '1080p' | '720p'
}

/**
 * The engine seam for the Linux backend.
 *
 * Windows boots obs-studio-node here. Linux boots ffmpeg and PulseAudio, and
 * exposes the subset of the ObsCore surface that index.ts and ipc.ts use.
 */
export class LinuxEngine {
  private initialized = false
  private config: LinuxConfig
  private audioTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private pulseSupported = true

  captureService: LinuxCaptureManager | null = null
  replayBufferService: LinuxReplayBuffer | null = null
  audioMixService: LinuxAudioMix | null = null
  audioDeviceChannelService: LinuxAudioDeviceChannels | null = null

  obs = null

  constructor(config?: Partial<LinuxConfig>) {
    this.config = {
      bufferDuration: 60,
      fps: 30,
      outputResolution: 'native',
      ...config,
      outputPath: config?.outputPath ?? '',
    }
  }

  wire(capture: LinuxCaptureManager, replay: LinuxReplayBuffer, audioMix: LinuxAudioMix, audioDevices: LinuxAudioDeviceChannels): void {
    this.captureService = capture
    this.replayBufferService = replay
    this.audioMixService = audioMix
    this.audioDeviceChannelService = audioDevices
  }

  getConfig(): LinuxConfig {
    return { ...this.config }
  }

  isInitialized(): boolean {
    return this.initialized
  }

  setBufferDuration(seconds: number): void {
    this.config.bufferDuration = seconds
  }

  async setOutputPath(p: string): Promise<void> {
    this.config.outputPath = p
    await this.replayBufferService?.setOutputDir(p)
    log.info(`Output path set to: ${p}`)
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      log.info('Already initialized')
      return
    }
    if (process.platform !== 'linux') throw new Error('The Linux engine only runs on Linux')
    if (!onX11()) {
      throw new Error(
        'Rewind on Linux captures an X11 desktop. This session is Wayland, which needs the PipeWire portal and is not supported yet.',
      )
    }
    if (!listMonitors().length) throw new Error('No display was found')

    await this.assertTools()

    this.audioMixService = this.audioMixService ?? new LinuxAudioMix()
    this.audioDeviceChannelService =
      this.audioDeviceChannelService ??
      new LinuxAudioDeviceChannels({ onChange: () => this.scheduleAudioRefresh() })

    await primeLinuxDevices(true)
    await this.audioMixService.refreshState()
    await this.audioDeviceChannelService.refreshState()
    this.audioMixService.setupDesktopMix()
    this.audioDeviceChannelService.setup()

    this.captureService?.setupScene()
    this.initialized = true
    log.info(
      `Linux engine ready: ${listMonitors().length} display(s), ` +
        `${this.audioMixService.hasMicrophone() ? 'microphone available' : 'no microphone'}, ` +
        `x264 ${qualityTarget(getSetting('visualQuality') as 'low' | 'balanced' | 'quality')}`,
    )
  }

  private async assertTools(): Promise<void> {
    const ffmpeg = resolveFfmpeg()
    try {
      const { stdout, stderr } = await execFileP(ffmpeg, ['-hide_banner', '-devices'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
      const devices = `${stdout}${stderr}`
      if (!/x11grab/.test(devices)) throw new Error('this ffmpeg build has no x11grab input')
      this.pulseSupported = / pulse /.test(devices)
      if (!this.pulseSupported) {
        log.warn(
          'This ffmpeg build has no PulseAudio input, so clips will have no audio. ' +
            'Run `npm run ffmpeg:linux` to install the Linux capture build.',
        )
      }
    } catch (e) {
      throw new Error(`ffmpeg could not capture X11 (${e instanceof Error ? e.message : e})`)
    }

    for (const tool of ['pactl', 'wmctrl']) {
      try {
        await execFileP(tool, tool === 'pactl' ? ['info'] : ['-h'], { timeout: 4000, maxBuffer: 1024 * 1024 })
      } catch (e) {
        // ffmpeg is the only hard requirement. A missing pactl means no device
        // list or app faders; a missing wmctrl means no window picker.
        log.warn(`Required tool "${tool}" is missing or not working: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  async prepareAudio(): Promise<void> {
    await this.audioMixService?.refreshState()
    await this.audioDeviceChannelService?.refreshState()
  }

  /** Everything the recorder needs for one start, assembled from live settings. */
  recorderOptions() {
    if (!this.captureService) throw new Error('Capture source is not ready')
    return {
      target: this.captureService.getTarget(),
      streams: this.recorderStreams(),
      fps: this.config.fps,
      quality: getSetting('visualQuality') as 'low' | 'balanced' | 'quality',
      outputResolution: this.config.outputResolution,
      outputDir: this.config.outputPath,
      bufferDuration: this.config.bufferDuration,
    }
  }

  /** Streams the recorder should subscribe to, in track order. */
  recorderStreams(): RecorderStream[] {
    const streams: RecorderStream[] = []
    if (!this.pulseSupported) return streams
    const desktop = this.audioMixService?.desktopStream()
    if (desktop) {
      streams.push({
        kind: 'desktop',
        source: desktop.source,
        label: 'Desktop',
        volume: desktop.volume,
        muted: desktop.muted,
      })
    }
    const mic = this.audioMixService?.micStream()
    if (mic) {
      streams.push({
        kind: 'microphone',
        source: mic.source,
        label: 'Microphone',
        volume: mic.volume,
        muted: mic.muted,
        gain: mic.gain,
      })
    }
    for (const device of this.audioDeviceChannelService?.streams() ?? []) {
      streams.push({
        kind: 'device',
        source: device.source,
        label: device.label,
        volume: device.volume,
        muted: device.muted,
      })
    }
    return streams
  }

  hasMicrophone(): boolean {
    return this.audioMixService?.hasMicrophone() ?? false
  }

  audioTrackLabels(): string[] {
    if (!this.pulseSupported) return []
    if (this.replayBufferService?.isReplayBufferActive()) return this.replayBufferService.audioTrackLabels()
    if (!this.audioMixService?.desktopStream()) return []
    const labels = ['Mix', 'Desktop']
    if (this.hasMicrophone()) labels.push('Microphone')
    const deviceLabels = (this.audioDeviceChannelService?.channelTracks() ?? []).map((t) => t.label)
    if (deviceLabels.length) labels.push(deviceLabels.join(' + '))
    return labels
  }

  audioTrackMask(): number {
    if (!this.pulseSupported) return 0
    let mask = (1 << (TRACK.MIX - 1)) | (1 << (TRACK.DESKTOP - 1))
    if (this.hasMicrophone()) mask |= 1 << (TRACK.MIC - 1)
    if ((this.audioDeviceChannelService?.channelTracks() ?? []).length) mask |= 1 << (TRACK.DEVICE_BASE - 1)
    return mask
  }

  /** Levels and bindings live in the filters, so applying them restarts the encode. */
  applyChannelLevel(_channel: AudioChannel): void {
    this.scheduleAudioRefresh()
  }

  applyChannelDevice(_channel: AudioChannel): void {
    this.scheduleAudioRefresh()
  }

  /**
   * A track layout change cannot be applied to segments already written: the old
   * ones have a different number of streams. Rebuild the window.
   */
  async applyAudioTracks(): Promise<void> {
    invalidateDeviceCache()
    await this.replayBufferService?.rebuildAndRestart()
  }

  async deviceAvailable(id: string, kind: DeviceKind): Promise<boolean> {
    return deviceAvailable(id, kind)
  }

  /** Public entry point for modules that change the mix outside the IPC layer. */
  audioChanged(): void {
    this.scheduleAudioRefresh()
  }

  /** Coalesces a slider drag into one restart. */
  private scheduleAudioRefresh(): void {
    if (this.audioTimer) clearTimeout(this.audioTimer)
    this.audioTimer = setTimeout(() => {
      this.audioTimer = null
      void this.replayBufferService?.refreshAudio().catch((e) => log.warn('Could not apply the audio change:', e))
    }, 300)
    this.audioTimer.unref?.()
  }

  forceCanvasSize(_width: number, _height: number): null {
    return null
  }

  syncCanvasToDisplay(): { changed: boolean; base: { width: number; height: number }; previous: string | null } {
    const m = listMonitors()[0]
    return { changed: false, base: { width: m?.width ?? 0, height: m?.height ?? 0 }, previous: null }
  }

  canvasChangePending(): { changed: boolean } {
    return { changed: false }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.audioTimer) clearTimeout(this.audioTimer)
    this.audioTimer = null
    try {
      await this.replayBufferService?.dispose()
    } catch (e) {
      log.warn('Failed to stop the recorder cleanly:', e)
    }
    this.audioMixService?.teardown()
    this.audioDeviceChannelService?.teardown()
    this.initialized = false
    this.shuttingDown = false
    log.info('Linux engine shut down')
  }

  markAbandoned(): void {
    void this.shutdown()
  }
}
