import { scope } from '../logger.js'
import { getSetting, setSetting } from '../store.js'
import { channelDevices, channelLevel } from '../audio-state.js'
import { invalidatePulse, pulseState, resolveSourceId, setAppLevel } from './pulse.js'
import type { PulseSource, PulseState } from './pulse.js'
import { SLOT, TRACK, AUDIO_SESSION_POLL_MS, DEVICE_LIST_TTL_MS } from '@shared/constants.js'
import type { AudioApp, AudioChannel, AudioDevice, DeviceKind } from '@shared/types.js'

const log = scope('AudioDevices')
const mixLog = scope('AudioMix')

const DEFAULT_SOUND = { volume: 1, muted: false }

/** One capture stream the recorder subscribes to. */
export interface LinuxAudioStream {
  /** PulseAudio source name handed to parec. */
  source: string
  label: string
  volume: number
  muted: boolean
}

export interface LinuxDesktopStream extends LinuxAudioStream {
  kind: 'desktop'
}

export interface LinuxMicStream extends LinuxAudioStream {
  kind: 'microphone'
  gain: number
}

export interface LinuxDeviceStream extends LinuxAudioStream {
  kind: 'device'
  /** Pulse source name, used to line the channel's track up with the recorded stream. */
  id: string
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function isCovered(device: { id: string; kind: DeviceKind; isSystemDefault: boolean }): AudioChannel | undefined {
  const channel: AudioChannel = device.kind === 'output' ? 'desktop' : 'microphone'
  const bound = channelDevices()[channel]
  if (bound === device.id) return channel
  if (bound === 'default' && device.isSystemDefault) return channel
  return undefined
}

let cachedDevices: { at: number; list: AudioDevice[] } | null = null

export function invalidateDeviceCache(): void {
  cachedDevices = null
  invalidatePulse()
}

/** Refreshes the endpoint inventory the settings UI reads synchronously. */
export async function primeLinuxDevices(force = false): Promise<AudioDevice[]> {
  if (!force && cachedDevices && Date.now() - cachedDevices.at < DEVICE_LIST_TTL_MS) return cachedDevices.list
  const state = await pulseState(force)
  const list: AudioDevice[] = state.sources.map((s) => ({
    id: s.name,
    label: s.label,
    kind: s.kind,
    available: true,
    added: false,
    isSystemDefault: s.isSystemDefault,
    coveredBy: isCovered({ id: s.name, kind: s.kind, isSystemDefault: s.isSystemDefault }),
    volume: 1,
    muted: false,
  }))
  cachedDevices = { at: Date.now(), list }
  return list
}

/** Endpoint inventory from the cache, refreshing in the background when stale. */
function cachedDeviceList(): AudioDevice[] {
  if (!cachedDevices || Date.now() - cachedDevices.at > DEVICE_LIST_TTL_MS) {
    void primeLinuxDevices(true).catch((e) => log.warn('Could not refresh audio devices:', e))
  }
  return cachedDevices?.list ?? []
}

export async function deviceAvailable(id: string, kind: DeviceKind): Promise<boolean> {
  const state = await pulseState(true)
  return resolveSourceId(state, id, kind) !== null
}

// ---------------------------------------------------------------------------
// Desktop mix
// ---------------------------------------------------------------------------

/**
 * Per-app levels on Linux are the app's own PulseAudio stream level.
 *
 * There is no process-loopback capture outside the desktop portal, so a fader
 * cannot be a gain on a separate copy of one app's audio: the desktop monitor is
 * already a mix of everything. Setting the stream level is the honest
 * equivalent, and it is why a fader here also changes what the user hears.
 */
export class LinuxAudioMix {
  private ready = false
  private syncTimer: NodeJS.Timeout | null = null
  /** Levels observed before Rewind first touched a stream, restored by resetMix. */
  private baseline = new Map<string, { volume: number; muted: boolean }>()
  private state: PulseState | null = null

  customized(): boolean {
    return Object.keys(getSetting('appAudioLevels')).length > 0
  }

  setupDesktopMix(): void {
    this.ready = true
    this.syncAll()
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = setInterval(() => this.tick(), AUDIO_SESSION_POLL_MS)
    this.syncTimer.unref?.()
  }

  teardown(): void {
    this.ready = false
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    this.baseline.clear()
  }

  /** Re-reads Pulse state and re-applies any saved per-app level. */
  private tick(): void {
    void this.refreshState()
      .then(() => this.syncAll())
      .catch((e) => mixLog.warn('Audio session poll failed:', e))
  }

  private syncAll(): void {
    if (!this.ready) return
    const levels = getSetting('appAudioLevels')
    for (const [exe, level] of Object.entries(levels)) {
      const inputs = this.state?.sinkInputs.filter((i) => i.exe === exe) ?? []
      if (!inputs.length) continue
      const already = inputs.every(
        (i) => Math.abs(i.volume - level.volume) < 0.005 && i.muted === level.muted,
      )
      if (already) continue
      void setAppLevel(exe, level.volume, level.muted).catch((e) => {
        mixLog.warn(`Could not apply the saved level for ${exe}:`, e)
      })
    }
  }

  getApps(): AudioApp[] {
    const levels = getSetting('appAudioLevels')
    const map = new Map<string, AudioApp>()

    for (const input of this.state?.sinkInputs ?? []) {
      const level = (levels[input.exe] ?? DEFAULT_SOUND) as { volume: number; muted: boolean }
      const existing = map.get(input.exe)
      map.set(input.exe, {
        exe: input.exe,
        displayName: titleCase(input.exe),
        running: (existing?.running ?? false) || input.running,
        // Every stream is inside the desktop monitor, so every app can be faded.
        capturable: true,
        volume: level.volume,
        muted: level.muted,
      })
    }

    // Persisted entries survive their process so the mix is not lost on exit.
    for (const [exe, level] of Object.entries(levels)) {
      if (map.has(exe)) continue
      map.set(exe, {
        exe,
        displayName: titleCase(exe),
        running: false,
        capturable: false,
        volume: level.volume,
        muted: level.muted,
      })
    }

    return [...map.values()].sort((a, b) =>
      a.running !== b.running ? (a.running ? -1 : 1) : a.displayName.localeCompare(b.displayName),
    )
  }

  setAppLevel(exe: string, patch: { volume?: number; muted?: boolean }): void {
    const key = exe.trim().toLowerCase()
    if (!key) throw new Error('Invalid app identifier')

    const all = getSetting('appAudioLevels')
    const merged = { ...(all[key] ?? DEFAULT_SOUND), ...patch }

    if (merged.volume === DEFAULT_SOUND.volume && merged.muted === DEFAULT_SOUND.muted) {
      delete all[key]
    } else {
      all[key] = merged
    }
    setSetting('appAudioLevels', all)

    if (!this.baseline.has(key)) {
      const live = this.state?.sinkInputs.find((i) => i.exe === key)
      if (live) this.baseline.set(key, { volume: live.volume, muted: live.muted })
    }
    void setAppLevel(key, merged.volume, merged.muted).catch((e) => {
      mixLog.warn(`Could not apply the level for ${key}:`, e)
    })
  }

  resetMix(): void {
    const previous = getSetting('appAudioLevels')
    setSetting('appAudioLevels', {})
    for (const key of Object.keys(previous)) {
      const original = this.baseline.get(key) ?? { volume: 1, muted: false }
      void setAppLevel(key, original.volume, original.muted).catch((e) => {
        mixLog.warn(`Could not restore the level for ${key}:`, e)
      })
    }
    this.baseline.clear()
    mixLog.info('Per-app mix reset to default desktop capture')
  }

  /** Levels ride the Pulse streams; there are no OBS tracks to assign. */
  applyTracks(): void {}

  desktopStream(): LinuxDesktopStream | null {
    if (!this.state) return null
    const source = resolveSourceId(this.state, channelDevices().desktop, 'output')
    if (!source) return null
    const level = channelLevel('desktop')
    return {
      kind: 'desktop',
      source,
      label: this.state.sources.find((s) => s.name === source)?.label ?? 'Desktop',
      volume: level.volume,
      muted: level.muted,
    }
  }

  micStream(): LinuxMicStream | null {
    if (!this.state) return null
    const source = resolveSourceId(this.state, channelDevices().microphone, 'input')
    if (!source) return null
    const level = channelLevel('microphone')
    return {
      kind: 'microphone',
      source,
      label: this.state.sources.find((s) => s.name === source)?.label ?? 'Microphone',
      volume: level.volume,
      muted: level.muted,
      gain: getSetting('micGain'),
    }
  }

  hasMicrophone(): boolean {
    if (!this.state) return false
    return resolveSourceId(this.state, channelDevices().microphone, 'input') !== null
  }

  sources(): PulseSource[] {
    return this.state?.sources ?? []
  }

  async refreshState(): Promise<void> {
    try {
      this.state = await pulseState()
    } catch (e) {
      mixLog.warn('Could not read PulseAudio state:', e)
    }
  }
}

// ---------------------------------------------------------------------------
// Extra device channels
// ---------------------------------------------------------------------------

export class LinuxAudioDeviceChannels {
  constructor(private readonly deps: { onChange?: () => void } = {}) {}

  setup(): void {
    // Nothing to open: the recorder reads the stored channels when it starts.
  }

  teardown(): void {}

  /** Synchronous, because the IPC handler returns the list directly. */
  getDevices(): AudioDevice[] {
    const available = cachedDeviceList()
    const stored = getSetting('deviceChannels')
    const tracks = new Map(this.channelTracks().map((t) => [t.id, t.track]))
    const map = new Map<string, AudioDevice>()

    for (const d of available) {
      const cfg = stored[d.id]
      map.set(d.id, {
        ...d,
        added: !!cfg,
        coveredBy: isCovered({ id: d.id, kind: d.kind, isSystemDefault: d.isSystemDefault }),
        volume: cfg?.volume ?? DEFAULT_SOUND.volume,
        muted: cfg?.muted ?? DEFAULT_SOUND.muted,
        track: tracks.get(d.id),
      })
    }

    for (const [id, cfg] of Object.entries(stored)) {
      if (map.has(id)) continue
      map.set(id, {
        id,
        label: cfg.label,
        kind: cfg.kind,
        available: false,
        added: true,
        isSystemDefault: false,
        volume: cfg.volume,
        muted: cfg.muted,
        error: 'Device not connected',
      })
    }

    return [...map.values()].sort((a, b) =>
      a.available !== b.available
        ? a.available
          ? -1
          : 1
        : a.kind !== b.kind
          ? a.kind === 'output'
            ? -1
            : 1
          : a.label.localeCompare(b.label),
    )
  }

  reconcileBindings(): void {
    const state = this.state
    if (!state) return
    const stored = { ...getSetting('deviceChannels') }
    let changed = false
    for (const [id, cfg] of Object.entries(stored)) {
      const source = state.sources.find((s) => s.name === id)
      if (source && isCovered({ id, kind: cfg.kind, isSystemDefault: source.isSystemDefault })) {
        delete stored[id]
        changed = true
        log.info(`Released added channel "${cfg.label}": its bound audio channel now covers it`)
      }
    }
    if (changed) {
      setSetting('deviceChannels', stored)
      this.deps.onChange?.()
    }
  }

  addChannel(id: string): void {
    const stored = getSetting('deviceChannels')
    if (stored[id]) return

    const found = cachedDeviceList().find((d) => d.id === id)
    if (!found) throw new Error('Audio device not found')
    if (isCovered(found)) {
      throw new Error(`"${found.label}" is already captured by its bound audio channel`)
    }
    if (Object.keys(stored).length >= SLOT.DEVICE_MAX) {
      throw new Error(`Cannot capture more than ${SLOT.DEVICE_MAX} extra audio devices`)
    }

    setSetting('deviceChannels', {
      ...stored,
      [id]: { kind: found.kind, label: found.label, ...DEFAULT_SOUND },
    })
    log.info(`Device channel added: "${found.label}"`)
  }

  removeChannel(id: string): void {
    const stored = { ...getSetting('deviceChannels') }
    if (!stored[id]) return
    const label = stored[id].label
    delete stored[id]
    setSetting('deviceChannels', stored)
    log.info(`Device channel removed: "${label}"`)
  }

  setLevel(id: string, patch: { volume?: number; muted?: boolean }): void {
    const stored = getSetting('deviceChannels')
    const cfg = stored[id]
    if (!cfg) throw new Error('Audio device channel not found')
    setSetting('deviceChannels', { ...stored, [id]: { ...cfg, ...patch } })
    this.deps.onChange?.()
  }

  channelTracks(): { id: string; track: number; label: string }[] {
    const stored = getSetting('deviceChannels')
    return this.streams().map((stream, i) => ({
      id: stream.id,
      track: TRACK.DEVICE_BASE + i,
      label: stored[stream.id]?.label ?? stream.label,
    }))
  }

  /** Resolved capture streams for the recorder, in settings order. */
  streams(): LinuxDeviceStream[] {
    if (!this.state) return []
    const stored = getSetting('deviceChannels')
    const out: LinuxDeviceStream[] = []
    for (const [id, cfg] of Object.entries(stored)) {
      const source = resolveSourceId(this.state, id, cfg.kind)
      if (!source) continue
      out.push({
        kind: 'device',
        id,
        source,
        label: cfg.label,
        volume: cfg.volume,
        muted: cfg.muted,
      })
    }
    return out
  }

  private state: PulseState | null = null

  async refreshState(): Promise<void> {
    try {
      this.state = await pulseState()
    } catch (e) {
      log.warn('Could not read PulseAudio state for device channels:', e)
    }
  }
}
