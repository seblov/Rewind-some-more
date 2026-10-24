import { scope } from '../logger.js'
import { getSetting } from '../store.js'
import { LinuxRecorder, qualityTarget } from './recorder.js'
import type { CaptureMode, VideoCodec } from '@shared/types.js'
import type { EncoderVendorInfo } from '@shared/types.js'

const log = scope('Replay')

interface LinuxEngineLike {
  getConfig(): { outputPath: string; bufferDuration: number; fps: number; outputResolution: string }
  setBufferDuration(seconds: number): void
  recorderOptions(): any
  prepareAudio(): Promise<void>
  audioTrackLabels(): string[]
}

/**
 * The rolling buffer, Linux edition.
 *
 * All of the OBS output plumbing is replaced by one recorder process: start it,
 * let it write segments, save by concatenating the window. The public surface is
 * the one index.ts and ipc.ts already call.
 */
export class LinuxReplayBuffer {
  private recorder = new LinuxRecorder()
  private active = false
  private startedAt = 0
  private finishedOnTeardown: string | null = null
  private lastReplayPath: string | null = null
  private saveInFlight: Promise<string> | null = null
  private disposed = false

  constructor(private readonly engine: LinuxEngineLike) {}

  setupReplayBuffer(): void {
    // Nothing to create up front; the buffer starts on demand.
  }

  get availableCodecs(): VideoCodec[] {
    return ['h264']
  }

  getAvailableCodecs(): VideoCodec[] {
    return ['h264']
  }

  /** There is no hardware encoder in the bundled ffmpeg; x264 is the one vendor. */
  getAvailableEncoderVendors(): EncoderVendorInfo[] {
    return [{ vendor: 'x264', label: 'x264 (CPU)', isHardware: false, codecs: ['h264'] }]
  }

  getActiveEncoderVendor(): 'x264' {
    return 'x264'
  }

  getActiveEncoder(): string {
    return 'libx264'
  }

  getQualityTarget(): string {
    return qualityTarget((getSetting('visualQuality') as 'low' | 'balanced' | 'quality') ?? 'balanced')
  }

  isReplayBufferActive(): boolean {
    return this.active && this.recorder.isActive()
  }

  bufferStartedAt(): number {
    return this.startedAt
  }

  isRecordingContinuously(): boolean {
    return this.recorder.isRecording()
  }

  continuousElapsedMs(): number {
    return this.isRecordingContinuously() ? Math.max(0, Date.now() - this.recorder.recordingStartedAtMs()) : 0
  }

  getLastReplayPath(): string | null {
    return this.lastReplayPath
  }

  takeFinishedOnTeardown(): string | null {
    const finished = this.finishedOnTeardown
    this.finishedOnTeardown = null
    return finished
  }

  async startReplayBuffer(_retry = false): Promise<void> {
    if (this.disposed) throw new Error('The capture engine has been shut down')
    if (this.active && this.recorder.isActive()) return
    await this.engine.prepareAudio()
    await this.recorder.start(this.engine.recorderOptions(), { clear: true })
    this.active = true
    this.startedAt = Date.now()
    log.info(`Replay buffer started (${this.engine.getConfig().bufferDuration}s)`)
  }

  async stopReplayBuffer(_force = false): Promise<void> {
    if (!this.active && !this.recorder.isRecording()) return
    const finished = await this.recorder.stop({ clear: true, finishRecording: true })
    if (finished) this.finishedOnTeardown = finished
    this.active = false
    this.startedAt = 0
    log.info('Replay buffer stopped')
  }

  async pauseReplayBuffer(): Promise<void> {
    await this.stopReplayBuffer(false)
    log.info('Replay buffer paused')
  }

  async saveReplayBuffer(_sourceType: CaptureMode = 'display'): Promise<string> {
    if (!this.active) throw new Error('Replay buffer is not running')
    if (this.saveInFlight) return this.saveInFlight

    const flight = this.recorder
      .save()
      .then((file) => {
        this.lastReplayPath = file
        return file
      })
      .finally(() => {
        this.saveInFlight = null
      })
    this.saveInFlight = flight
    return flight
  }

  async startContinuousRecording(): Promise<void> {
    if (!this.isReplayBufferActive()) throw new Error('The buffer is not running, so nothing would be recorded')
    this.recorder.startRecording()
  }

  async stopContinuousRecording(): Promise<string> {
    if (!this.recorder.isRecording()) throw new Error('Not currently recording')
    return this.recorder.stopRecording()
  }

  abortContinuousRecording(): void {
    // The recorder keeps its segments; aborting a recording has no separate state.
    log.info('Continuous recording abandoned')
  }

  async setBufferDuration(seconds: number): Promise<void> {
    this.engine.setBufferDuration(seconds)
    this.recorder.setBufferDuration(seconds)
  }

  async rebuildAndRestart(): Promise<void> {
    const wasActive = this.active
    await this.recorder.stop({ clear: true, finishRecording: true })
    this.active = false
    if (wasActive) await this.startReplayBuffer(true)
  }

  /** Applies a level or device change without dropping the buffered window. */
  async refreshAudio(): Promise<void> {
    if (!this.active) return
    await this.engine.prepareAudio()
    await this.recorder.apply(this.engine.recorderOptions())
    log.info(`Audio mix applied to the running buffer (${this.recorder.audioTrackLabels().join(' / ')})`)
  }

  async setOutputDir(dir: string): Promise<void> {
    this.recorder.setOutputDir(dir)
  }

  audioTrackLabels(): string[] {
    return this.recorder.isActive() ? this.recorder.audioTrackLabels() : this.engine.audioTrackLabels()
  }

  async recover(): Promise<void> {
    if (this.disposed) return
    // `active` can be true while the child is gone (an encoder crash), and that is
    // exactly the case recovery exists for.
    if (this.active && this.recorder.isActive()) return
    await this.recorder.recover()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const finished = await this.recorder.stop({ clear: true, finishRecording: true })
    if (finished) this.finishedOnTeardown = finished
    this.active = false
    this.startedAt = 0
  }

  noteObsError(): boolean {
    return false
  }

  setSoftwareFallback(): void {}
  clearSoftwareFallback(): void {}
  markAbandoned(): void {
    void this.dispose()
  }
}
