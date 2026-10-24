import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scope } from '../logger.js'

const log = scope('Pulse')
const execFileP = promisify(execFile)

/**
 * PulseAudio / PipeWire facts.
 *
 * The Linux backend does not embed a mixer: endpoints and app streams are read
 * from `pactl`, and per-app levels are applied to the Pulse stream the app is
 * already playing through. pactl 16 (Debian 12, Ubuntu 23.04, Fedora 36) prints
 * JSON; older builds fall back to the text format, which is stable too.
 */

export type PulseKind = 'output' | 'input'

export interface PulseSource {
  index: number
  /** The id the app stores in settings and hands to parec. */
  name: string
  label: string
  kind: PulseKind
  isSystemDefault: boolean
}

export interface PulseSinkInput {
  index: number
  exe: string
  displayName: string
  volume: number
  muted: boolean
  running: boolean
}

export interface PulseState {
  sources: PulseSource[]
  sinkInputs: PulseSinkInput[]
  defaultSink: string
  defaultSource: string
}

interface JsonSource {
  index: number
  name: string
  description?: string
  mute?: boolean
  monitor_source?: string
  volume?: Record<string, { value_percent?: string }>
  properties?: Record<string, string>
}

interface JsonSinkInput {
  index: number
  sink?: number
  mute?: boolean
  corked?: boolean
  volume?: Record<string, { value_percent?: string }>
  properties?: Record<string, string>
}

interface JsonInfo {
  default_sink_name?: string
  default_source_name?: string
}

const SELF = new Set(['electron', 'rewind', 'parec', 'ffmpeg', 'pactl', 'pw-record'])

let cache: { at: number; state: Promise<PulseState> } | null = null

/** Cached snapshot. One second is short enough for live UI, long enough to stop polling storms. */
export function pulseState(force = false): Promise<PulseState> {
  if (!force && cache && Date.now() - cache.at < 1000) return cache.state
  const state = readState()
  cache = { at: Date.now(), state }
  state.catch(() => {
    if (cache?.state === state) cache = null
  })
  return state
}

export function invalidatePulse(): void {
  cache = null
}

async function pactl(args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileP('pactl', args, { timeout, maxBuffer: 8 * 1024 * 1024 })
  return String(stdout)
}

async function readState(): Promise<PulseState> {
  try {
    const [infoRaw, sourceRaw, inputRaw] = await Promise.all([
      pactl(['-f', 'json', 'info']),
      pactl(['-f', 'json', 'list', 'sources']),
      pactl(['-f', 'json', 'list', 'sink-inputs']),
    ])
    return fromJson(JSON.parse(infoRaw) as JsonInfo, JSON.parse(sourceRaw) as JsonSource[], JSON.parse(inputRaw) as JsonSinkInput[])
  } catch (e) {
    log.warn('pactl JSON output unavailable, falling back to text:', e)
    return readStateText()
  }
}

function fromJson(info: JsonInfo, sources: JsonSource[], inputs: JsonSinkInput[]): PulseState {
  const defaultSink = info.default_sink_name ?? ''
  const defaultSource = info.default_source_name ?? ''

  return {
    defaultSink,
    defaultSource,
    sources: sources.map((s) => {
      // Monitor sources carry the sink they mirror in `monitor_source`. That is the
      // only reliable classification: a sink's name does not have to end in
      // `.monitor` once a user renames it.
      const monitor = !!s.monitor_source
      const isDefault = monitor ? s.monitor_source === defaultSink : s.name === defaultSource
      return {
        index: s.index,
        name: s.name,
        label: s.description || s.name,
        kind: monitor ? 'output' : 'input',
        isSystemDefault: isDefault,
      }
    }),
    sinkInputs: inputs
      .map((i) => sinkInputFromJson(i))
      .filter((i): i is PulseSinkInput => i !== null),
  }
}

function sinkInputFromJson(input: JsonSinkInput): PulseSinkInput | null {
  const props = input.properties ?? {}
  const exe = normalizeExe(props['application.process.binary'] || props['application.name'] || props['node.name'] || '')
  if (!exe || SELF.has(exe)) return null
  const percent = firstPercent(input.volume)
  return {
    index: input.index,
    exe,
    displayName: props['application.name'] || props['node.name'] || exe,
    volume: percent,
    muted: !!input.mute,
    // A corked stream exists but is not currently producing sound. Keep it in the
    // list so its saved level still applies when it resumes.
    running: !input.corked,
  }
}

async function readStateText(): Promise<PulseState> {
  const [infoRaw, sourceRaw, inputRaw] = await Promise.all([
    pactl(['info']),
    pactl(['list', 'sources']),
    pactl(['list', 'sink-inputs']),
  ]).catch((e) => {
    throw new Error(`Could not read PulseAudio state with pactl: ${e instanceof Error ? e.message : e}`)
  })

  const defaultSink = /Default Sink:\s*(.+)/.exec(infoRaw)?.[1]?.trim() ?? ''
  const defaultSource = /Default Source:\s*(.+)/.exec(infoRaw)?.[1]?.trim() ?? ''

  const sources: PulseSource[] = []
  for (const block of splitBlocks(sourceRaw, 'Source #')) {
    const index = Number(block.header)
    const name = /^\s*Name:\s*(.+)$/m.exec(block.body)?.[1]?.trim() ?? ''
    if (!name) continue
    const description = /^\s*Description:\s*(.+)$/m.exec(block.body)?.[1]?.trim() ?? name
    const monitorOf = /^\s*Monitor of Sink:\s*(.+)$/m.exec(block.body)?.[1]?.trim() ?? ''
    const isDefault = monitorOf ? monitorOf === defaultSink : name === defaultSource
    sources.push({
      index,
      name,
      label: description,
      kind: monitorOf ? 'output' : 'input',
      isSystemDefault: isDefault,
    })
  }

  const sinkInputs: PulseSinkInput[] = []
  for (const block of splitBlocks(inputRaw, 'Sink Input #')) {
    const exe = normalizeExe(
      /^\s*application\.process\.binary\s*=\s*"?(.+?)"?\s*$/m.exec(block.body)?.[1] ??
        /^\s*application\.name\s*=\s*"?(.+?)"?\s*$/m.exec(block.body)?.[1] ??
        '',
    )
    if (!exe || SELF.has(exe)) continue
    const percent = Number(/(\d+)%/.exec(/^\s*Volume:.*$/m.exec(block.body)?.[0] ?? '')?.[1] ?? 100) / 100
    sinkInputs.push({
      index: Number(block.header),
      exe,
      displayName:
        /^\s*application\.name\s*=\s*"?(.+?)"?\s*$/m.exec(block.body)?.[1] ?? exe,
      volume: percent,
      muted: /^\s*Mute:\s*yes\s*$/m.test(block.body),
      running: !/^\s*Corked:\s*yes\s*$/m.test(block.body),
    })
  }

  return { sources, sinkInputs, defaultSink, defaultSource }
}

function splitBlocks(text: string, header: string): { header: string; body: string }[] {
  const parts = text.split(header).slice(1)
  return parts.map((part) => {
    const nl = part.indexOf('\n')
    return nl < 0 ? { header: part.trim(), body: '' } : { header: part.slice(0, nl).trim(), body: part.slice(nl) }
  })
}

function firstPercent(volume: JsonSinkInput['volume']): number {
  if (!volume) return 1
  for (const channel of Object.values(volume)) {
    const n = Number((channel.value_percent ?? '').replace('%', ''))
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n / 100))
  }
  return 1
}

function normalizeExe(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name)
    .replace(/^"|"$/g, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
    .trim()
}

/** Resolves the source name parec should record for a stored device id. */
export function resolveSourceId(state: PulseState, id: string, kind: PulseKind): string | null {
  if (id === 'default' || !id) {
    return kind === 'output'
      ? state.sources.find((s) => s.kind === 'output' && s.isSystemDefault)?.name ?? null
      : state.sources.find((s) => s.kind === 'input' && s.isSystemDefault)?.name ?? null
  }
  const hit = state.sources.find((s) => s.name === id)
  return hit && hit.kind === kind ? hit.name : null
}

export function hasKind(state: PulseState, kind: PulseKind): boolean {
  return state.sources.some((s) => s.kind === kind)
}

/** Sets the level of every live stream belonging to one app. */
export async function setAppLevel(exe: string, volume: number, muted: boolean): Promise<number> {
  const state = await pulseState(true)
  const targets = state.sinkInputs.filter((i) => i.exe === exe)
  const percent = `${Math.round(Math.min(1, Math.max(0, volume)) * 100)}%`
  await Promise.all(
    targets.flatMap((input) => [
      pactl(['set-sink-input-volume', String(input.index), percent]).catch((e) => {
        log.warn(`Could not set volume for ${exe} (stream ${input.index}):`, e)
      }),
      pactl(['set-sink-input-mute', String(input.index), muted ? '1' : '0']).catch((e) => {
        log.warn(`Could not set mute for ${exe} (stream ${input.index}):`, e)
      }),
    ]),
  )
  invalidatePulse()
  return targets.length
}
