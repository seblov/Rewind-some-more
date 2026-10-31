import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, clipUrl, formatBytes, formatDuration, messageOf } from '../lib/api'
import { usePreviewAudio } from '../lib/editor-audio'
import { Button, CenteredSpinner, Dialog, ProgressBar, cn } from './ui'
import {
  canSave,
  cutAt,
  cutTarget,
  deleteItems,
  formatTimecode,
  layout,
  MIN_SEGMENT_SEC,
  outAt,
  parseTimecode,
  removeRange,
  snapToFrame,
  spanAtOut,
  splicePeaks,
  srcAt,
  type Item,
  type Keep,
  type Layout,
  type Span,
} from '@shared/cut.js'
import type { ClipAudioTrack, ClipEditorInfo } from '@shared/types.js'

/** The part of the editor state an undo step restores. */
interface Snapshot {
  items: Item[]
  selected: number[]
}

/**
 * Chrome-less video element.
 *
 * A plain `<video>` is used rather than wavesurfer's media element because the
 * editor needs frame-accurate `currentTime` control for timeline scrubbing, and the
 * browser's own controls would fight the timeline. The element ref is owned by the
 * parent so seeking and play/pause can drive it directly.
 */
function VideoPreview({
  src,
  videoRef,
  onTimeUpdate,
  onDurationChange,
  onPlayStateChange,
  onError,
}: {
  src: string
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  onTimeUpdate: (t: number) => void
  onDurationChange: (d: number) => void
  onPlayStateChange: (playing: boolean) => void
  onError: (msg: string) => void
}) {
  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    const onTime = () => onTimeUpdate(el.currentTime)
    const onDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) onDurationChange(el.duration)
    }
    const onPlay = () => onPlayStateChange(true)
    const onPause = () => onPlayStateChange(false)
    const onEnded = () => onPlayStateChange(false)
    const onErr = () => {
      const codes: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED',
        2: 'MEDIA_ERR_NETWORK',
        3: 'MEDIA_ERR_DECODE',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      }
      const code = el.error?.code ?? 0
      onError(`Video load failed: ${codes[code] ?? `code ${code}`} (${src})`)
    }

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onDuration)
    el.addEventListener('loadedmetadata', onDuration)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onErr)

    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onDuration)
      el.removeEventListener('loadedmetadata', onDuration)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('error', onErr)
    }
  }, [src, videoRef, onTimeUpdate, onDurationChange, onPlayStateChange, onError])

  return <video ref={videoRef} src={src} preload="auto" controls={false} className="max-h-full max-w-full" />
}

/** Seconds to a percentage of the timeline, clamped to [0, 100]. */
function pct(seconds: number, duration: number): number {
  const total = duration > 0 ? duration : 1
  return (Math.max(0, Math.min(seconds, total)) / total) * 100
}

/** A marked range's length: tenths under a minute, so a short cut does not read as 0:00. */
function rangeLabel(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatDuration(seconds)
}

/**
 * The clip editor.
 *
 * The edit is one ordered list of pieces -- what the clip still keeps, and the gaps
 * it holds -- with its own undo history. Dragging across the timeline marks a range
 * and Cut out removes it in one step; Split divides the piece under the playhead,
 * Delete closes a piece up (or leaves a gap), and the file is written from that same
 * list. Waveform peaks are computed in the main process (ffmpeg decode) and rendered
 * as bars, which avoids shipping a waveform renderer and keeps memory bounded for
 * long clips.
 */
export function EditorPage({ clipPath }: { clipPath: string }) {
  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<ClipEditorInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState<{ mode: 'overwrite' | 'copy' } | null>(null)
  /** Replacing the source is irreversible, so it asks before writing. */
  const [confirmReplace, setConfirmReplace] = useState(false)

  const [duration, setDuration] = useState(0)
  /*
   * The edit, with its own undo history.
   *
   * One state object per step rather than three arrays: undo restores the items *and*
   * the selection the edit was made from, and a history that could disagree with what
   * is on screen would be worse than none. The playhead is not in here: it is where
   * the user is looking, not what they changed.
   */
  const [history, setHistory] = useState<{ past: Snapshot[]; present: Snapshot; future: Snapshot[] }>(() => ({
    past: [],
    present: { items: [], selected: [] },
    future: [],
  }))
  const { items, selected } = history.present
  const [currentSec, setCurrentSec] = useState(0)
  /** The stretch dragged across the timeline, in output seconds. What Cut out removes. */
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  // Kept apart from `loadError`: a preview that will not decode is not a reason to
  // throw away the loaded metadata and the edit the user has already made.
  const [previewError, setPreviewError] = useState<string | null>(null)
  /** Why the last cut was refused, shown beside the buttons until it goes stale. */
  const [cutNotice, setCutNotice] = useState<string | null>(null)
  const [snap, setSnap] = useState(true)
  /** What the timecode box reads while it is being typed in; null when it follows the playhead. */
  const [tcDraft, setTcDraft] = useState<string | null>(null)

  const [tracks, setTracks] = useState<ClipAudioTrack[]>([])
  const [volumes, setVolumes] = useState<Record<number, number>>({})
  /*
   * Overall clip loudness, applied to every track.
   *
   * Kept separate from the per-track values rather than folded into them, so
   * moving the master does not overwrite what the user set per track: the two
   * multiply at save time. Folding it in would make "reset the track" and "nudge
   * the master" fight each other, and there would be no way back to the original
   * per-track balance without redoing it by hand.
   *
   * There is no separate mute: a fader at zero IS the mute, on screen and on save.
   */
  const [masterVolume, setMasterVolume] = useState(1)
  const [peaks, setPeaks] = useState<Record<number, number[]>>({})

  const videoRef = useRef<HTMLVideoElement>(null)
  /** Item ids come from here: undo can restore an old list, so they must never repeat. */
  const nextIdRef = useRef(1)
  const nextId = useCallback(() => nextIdRef.current++, [])
  /** The edit a trim drag started from, pushed as one history entry when it ends. */
  const trimOrigin = useRef<Snapshot | null>(null)
  /** The gap playback is holding, and when it ends. An ordinary seek calls it off. */
  const gapHold = useRef<{ until: number; from: number; outFrom: number; lastPush: number; resumeAt: number } | null>(null)

  const shape = useMemo(() => layout(items), [items])
  const spans = shape.spans
  const fps = info?.fps ?? 0

  /** Writes a new edit and clears the redo tail, the way every editor does. */
  const commit = useCallback((next: Snapshot) => {
    // An edit moves the sequence, so a range marked on the old one no longer means
    // anything. Selection is part of the snapshot and survives or clears on its own.
    setRange(null)
    setHistory((h) => ({ past: [...h.past.slice(-49), h.present], present: next, future: [] }))
  }, [])

  /** Selection changes are not edits: they do not land in the history. */
  const select = useCallback((ids: number[]) => {
    if (ids.length > 0) setRange(null)
    setHistory((h) => ({ ...h, present: { ...h.present, selected: ids } }))
  }, [])

  /** Marks a range, or clears it. A range and a piece selection are never both live. */
  const pickRange = useCallback((next: { from: number; to: number } | null) => {
    setRange(next)
    if (next) setHistory((h) => ({ ...h, present: { ...h.present, selected: [] } }))
  }, [])

  const undo = useCallback(() => {
    setRange(null)
    setHistory((h) =>
      h.past.length === 0
        ? h
        : { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [...h.future, h.present] },
    )
  }, [])

  const redo = useCallback(() => {
    setRange(null)
    setHistory((h) =>
      h.future.length === 0
        ? h
        : { past: [...h.past, h.present], present: h.future[h.future.length - 1], future: h.future.slice(0, -1) },
    )
  }, [])

  /**
   * Moves the playhead, in sequence time, and takes the preview to the matching frame.
   *
   * Sequence time, not source time: the timeline the user sees is the sequence, so
   * every control that moves the playhead speaks the same clock. Over a gap there is
   * no frame to show and the element stays where it is; the picture is held black
   * instead of jumping to the next piece.
   */
  const seekIn = useCallback((nextSpans: Span[], nextDuration: number, outT: number) => {
    // A seek is the user taking over: whatever gap was being held is over.
    gapHold.current = null
    const target = Math.max(0, Math.min(outT, nextDuration))
    const src = srcAt(nextSpans, target)
    const video = videoRef.current
    if (video && src !== null) video.currentTime = src
    setCurrentSec(target)
  }, [])

  const seek = useCallback(
    (outT: number) => seekIn(spans, shape.duration, outT),
    [seekIn, shape.duration, spans],
  )

  /** Play/pause the element, picking up at the nearest piece when the playhead cannot play. */
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    if (currentSec >= shape.duration - 0.001) {
      seek(0)
    } else if (srcAt(spans, currentSec) === null) {
      // Over a gap a press of play means "carry on from here": the gap is held by the
      // seam guard during playback, and starting inside one would otherwise play
      // whatever frame the element was left on.
      const gapEnd = spanAtOut(spans, currentSec)?.outOut ?? 0
      seek(gapEnd >= shape.duration - 0.001 ? 0 : gapEnd)
    }
    void video.play().catch(() => setPlaying(false))
  }, [currentSec, shape.duration, spans, seek])

  // Load clip metadata, then waveform peaks for each audio track.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      setLoading(true)
      try {
        const res = await api.editorGetClipInfo(clipPath)
        if (cancelled) return
        if (!res.success || !res.data) {
          // `error` only exists on the failure branch of the envelope.
          setLoadError(res.success ? 'Failed to load clip' : res.error)
          setLoading(false)
          return
        }

        const data = res.data
        setInfo(data)
        setDuration(data.duration || 0)
        // The whole clip is the starting edit: one piece, nothing removed.
        setHistory({
          past: [],
          present: {
            items:
              data.duration > 0 ? [{ id: nextId(), kind: 'keep', srcIn: 0, srcOut: data.duration }] : [],
            selected: [],
          },
          future: [],
        })
        setTracks(data.audioTracks)
        setLoading(false)

        for (const track of data.audioTracks) {
          const peaksRes = await api.editorGetTrackPeaks(clipPath, track.stream)
          if (cancelled) return
          if (peaksRes.success && peaksRes.data) {
            setPeaks((prev) => ({ ...prev, [track.stream]: peaksRes.data as number[] }))
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(messageOf(e, 'Failed to load clip'))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [clipPath, nextId])

  /**
   * The element reports in source time; the playhead is in sequence time.
   *
   * A frame that has run a hair past its piece -- the element's own clock is coarse
   * until the seam guard moves it -- maps to nothing, and the playhead stays put
   * rather than jumping somewhere the picture is not.
   */
  const onTimeUpdate = useCallback(
    (t: number) => {
      const mapped = outAt(spans, t)
      if (mapped !== null) setCurrentSec(mapped)
    },
    [spans],
  )

  const onPlayStateChange = useCallback((next: boolean) => {
    setPlaying(next)
  }, [])

  /*
   * Playback skips the seams.
   *
   * `timeupdate` fires about four times a second, which is far too coarse for this: a
   * piece could play a quarter second of removed footage before the handler noticed.
   * This walks the element every frame, stops one frame short of the piece's end, and
   * moves to whatever follows it: the next piece, a gap held black for its own length
   * with the playhead crawling across it, or the top of the sequence again at the end.
   *
   * The hold lives in a ref, not in this effect's scope, because holding a gap pauses
   * the element on purpose -- and a pause re-runs this effect. A hold kept in a local
   * would be dropped on the spot, leaving the user stopped at the seam they just
   * crossed.
   */
  useEffect(() => {
    // A hold keeps the loop alive even though the element is paused: that pause is the
    // hold working, not the user stopping.
    if (!playing && !gapHold.current) return
    const frame = fps > 0 ? 1 / fps : 0.033
    let raf = 0
    let piece: Span | null = null

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      if (!video) return
      const now = performance.now()
      const hold = gapHold.current

      if (hold) {
        if (now < hold.until) {
          // Coarse on purpose: the picture is held, and the playhead only has to look
          // like it is crossing the gap.
          if (now - hold.lastPush > 100) {
            hold.lastPush = now
            setCurrentSec(hold.outFrom + (now - hold.from) / 1000)
          }
          return
        }
        gapHold.current = null
        seek(hold.resumeAt)
        void video.play().catch(() => setPlaying(false))
        return
      }

      if (!piece || !spans.includes(piece)) {
        const at = outAt(spans, video.currentTime)
        piece = at === null ? null : spanAtOut(spans, at)
      }
      if (!piece || piece.item.kind !== 'keep') return
      if (video.currentTime < piece.item.srcOut - frame) return

      // The piece is done. One frame of headroom: the element is asked to stop just
      // before the frame the piece should not include.
      const next = spans[spans.indexOf(piece) + 1]
      if (!next) {
        piece = null
        seek(0)
        return
      }
      piece = next
      if (next.item.kind === 'gap') {
        const after = spans[spans.indexOf(next) + 1]
        video.pause()
        gapHold.current = {
          until: now + next.item.durSec * 1000,
          from: now,
          outFrom: next.outIn,
          lastPush: now,
          resumeAt: after ? after.outIn : 0,
        }
        piece = after ?? null
        setCurrentSec(next.outIn)
        return
      }
      seek(next.outIn)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, spans, fps, seek])

  /*
   * The playhead cannot outlive the sequence it points into: a delete or an undo can
   * move the end to the left of it.
   */
  useEffect(() => {
    if (currentSec > shape.duration + 0.001) seek(shape.duration)
  }, [currentSec, shape.duration, seek])

  useEffect(() => {
    if (!cutNotice) return
    const t = window.setTimeout(() => setCutNotice(null), 2500)
    return () => window.clearTimeout(t)
  }, [cutNotice])

  /*
   * What actually gets written: master x per-track, per stream.
   *
   * The multiply happens here rather than in the ffmpeg filter chain so that
   * main receives one plain number per track and never has to know a master
   * exists. Two sliders, one value.
   */
  const trackVolumes = useMemo(
    () =>
      tracks.map((t) => ({
        stream: t.stream,
        volume: masterVolume * (volumes[t.stream] ?? 1),
      })),
    [tracks, volumes, masterVolume],
  )

  // The waveforms cut to match the sequence, so a lane ends where the picture does
  // and a gap shows the silence that will actually be written there.
  const splicedPeaks = useMemo(() => {
    const out: Record<number, number[]> = {}
    if (!duration) return out
    for (const track of tracks) {
      const raw = peaks[track.stream]
      if (raw?.length) out[track.stream] = splicePeaks(raw, duration, items)
    }
    return out
  }, [peaks, tracks, duration, items])

  // The clip row's waveform: the loudest of the tracks at each point, so the
  // master line reads as the shape of the whole mix without decoding it again.
  // Computed here because every hook must sit above the early returns below.
  const masterPeaks = useMemo(() => {
    const arrays = tracks.map((t) => splicedPeaks[t.stream]).filter((p): p is number[] => !!p && p.length > 0)
    if (arrays.length === 0) return null
    const len = Math.min(...arrays.map((a) => a.length))
    const out = new Array<number>(len)
    for (let i = 0; i < len; i++) {
      let loudest = 0
      for (const a of arrays) if (a[i] > loudest) loudest = a[i]
      out[i] = loudest
    }
    return out
  }, [tracks, splicedPeaks])

  const volumesChanged = masterVolume !== 1 || Object.values(volumes).some((v) => v !== 1)

  // Live monitoring: the sliders are heard as they are dragged, no re-encode.
  usePreviewAudio({ ready: !loading, broken: !!previewError, videoRef, tracks, volumes, masterVolume })

  // Where a cut would land right now, or why it cannot. The button and the C key run
  // the same rule the writer does, from the same module in @shared/cut.js.
  const target = useMemo(() => cutTarget(items, currentSec, fps), [items, currentSec, fps])
  const cutBlocked = 'error' in target ? target.error : null

  const cut = useCallback(() => {
    if ('error' in target) {
      setCutNotice(target.error)
      return
    }
    setCutNotice(null)
    // The playhead ends up on the new seam, and nothing is selected: which side the
    // user means is theirs to say, and picking one for them would be a guess.
    commit({ items: cutAt(items, currentSec, fps, nextId), selected: [] })
  }, [target, items, currentSec, fps, nextId, commit])

  /** Removes the marked range and closes the sequence up, the way Delete removes a piece. */
  const cutOut = useCallback(() => {
    if (!range) return
    setCutNotice(null)
    const next = removeRange(items, range.from, range.to, fps, nextId)
    commit({ items: next, selected: [] })
    // Land on the join, read from the sequence being written: the old layout still
    // points at the first removed frame.
    const after = layout(next)
    seekIn(after.spans, after.duration, range.from)
  }, [range, items, fps, nextId, commit, seekIn])

  const removeSelected = useCallback(
    (mode: 'ripple' | 'lift') => {
      if (selected.length === 0) return
      commit({ items: deleteItems(items, selected, mode), selected: [] })
    },
    [selected, items, commit],
  )

  const reset = useCallback(() => {
    if (!duration) return
    commit({ items: [{ id: nextId(), kind: 'keep', srcIn: 0, srcOut: duration }], selected: [] })
  }, [duration, nextId, commit])

  /*
   * The editing keys, kept to the ones an NLE user already knows.
   *
   * All of them are ignored while a field has focus, so the timecode box can be typed
   * in. Ctrl/Cmd+Z and Ctrl/Cmd+K follow Premiere and DaVinci; bare C is the split, S
   * toggles snapping, and Delete takes the marked range or the selected piece out with
   * the sequence closing up behind it (Shift+Delete leaves black in a piece's place).
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const mod = e.ctrlKey || e.metaKey
      const frame = fps > 0 ? 1 / fps : 0.02
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && e.code === 'KeyY') {
        e.preventDefault()
        redo()
      } else if (mod && e.code === 'KeyK') {
        e.preventDefault()
        cut()
      } else if (e.code === 'KeyC' && !mod) {
        cut()
      } else if (e.code === 'KeyR' && !mod) {
        reset()
      } else if (e.code === 'KeyS' && !mod) {
        setSnap((v) => !v)
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (range) {
          e.preventDefault()
          cutOut()
          return
        }
        if (selected.length === 0) return
        e.preventDefault()
        removeSelected(e.shiftKey ? 'lift' : 'ripple')
      } else if (e.code === 'Escape') {
        select([])
        pickRange(null)
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault()
        seek(currentSec + (e.code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : frame))
      } else if (e.code === 'Home') {
        e.preventDefault()
        seek(0)
      } else if (e.code === 'End') {
        e.preventDefault()
        seek(shape.duration)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    togglePlay,
    undo,
    redo,
    cut,
    cutOut,
    reset,
    removeSelected,
    select,
    pickRange,
    seek,
    currentSec,
    shape.duration,
    fps,
    selected.length,
    range,
  ])

  // A trim drag is one undo step, pushed when the drag ends rather than on every
  // mouse move: a hundred entries for one handle would make undo useless.
  const onTrimStart = useCallback(() => {
    setRange(null)
    trimOrigin.current = history.present
  }, [history.present])

  const onTrim = useCallback((next: Item[]) => {
    setHistory((h) => ({ ...h, present: { ...h.present, items: next } }))
  }, [])

  const onTrimEnd = useCallback(() => {
    const origin = trimOrigin.current
    trimOrigin.current = null
    if (!origin) return
    setHistory((h) => ({ past: [...h.past.slice(-49), origin], present: h.present, future: [] }))
  }, [])

  /** What Compress acts on: the selected piece, else the piece under the playhead. */
  const exportSpan = useMemo(() => {
    const picked = spans.find((s) => s.item.kind === 'keep' && selected.includes(s.item.id))
    const under = spanAtOut(spans, currentSec)
    const span = picked ?? (under && under.item.kind === 'keep' ? under : null)
    if (!span || span.item.kind !== 'keep') return null
    return { startSec: span.item.srcIn, endSec: span.item.srcOut, fromSelection: !!picked }
  }, [spans, selected, currentSec])

  // Where the selection sits on the output timeline, for the lane highlights.
  const selectionSpan = useMemo(() => {
    const picks = spans.filter((s) => selected.includes(s.item.id))
    if (picks.length === 0) return null
    return { startSec: picks[0].outIn, endSec: picks[picks.length - 1].outOut }
  }, [spans, selected])

  /** True while the playhead sits over a gap: black on the timeline, black on screen. */
  const gapHere = spanAtOut(spans, currentSec)?.item.kind === 'gap'

  // An edit worth warning about on close: anything but the whole clip, untouched.
  const edited =
    items.length !== 1 ||
    items[0]?.kind !== 'keep' ||
    items[0].srcIn > 0.01 ||
    items[0].srcOut < duration - 0.01

  const close = useCallback(() => {
    if (edited && !window.confirm('Close without saving the cuts?')) return
    void api.editorCancel()
  }, [edited])

  const saveState = canSave(items)
  const gapCount = shape.gaps.length
  const summary = [
    `${shape.kept.length} piece${shape.kept.length === 1 ? '' : 's'}`,
    gapCount ? `${gapCount} gap${gapCount === 1 ? '' : 's'}` : null,
    volumesChanged
      ? 'audio re-encoded'
      : gapCount
        ? 'black and silence in the gap'
        : 'stream copy when every cut lands on a keyframe',
  ]
    .filter(Boolean)
    .join(' · ')

  /**
   * Reads the timecode box back, including the frame field it shows.
   *
   * The frames are meaningless without the clip's rate, which @shared/cut.js's
   * parser deliberately does not know, so they are added here.
   */
  const readTimecode = useCallback(
    (text: string): number => {
      const parts = text.trim().split(':')
      if (parts.length === 4 && fps > 0) {
        const frames = Number(parts[3])
        const base = parseTimecode(parts.slice(0, 3).join(':'))
        return Number.isFinite(base) && Number.isFinite(frames) ? base + frames / fps : NaN
      }
      return parseTimecode(text)
    },
    [fps],
  )

  const save = async (mode: 'overwrite' | 'copy') => {
    setSaving({ mode })
    setSaveError(null)
    try {
      const res = await api.editorSaveClip({ clipPath, items, mode, trackVolumes })
      if (!res.success) {
        setSaveError(res.error || 'Failed to save clip')
        setSaving(null)
        return
      }
      await api.editorCancel()
    } catch (e) {
      setSaveError(messageOf(e, 'Failed to save clip'))
      setSaving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <CenteredSpinner />
      </div>
    )
  }

  if (loadError || !info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center">
        <p className="text-sm text-danger">{loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void api.editorCancel()}>
          Close editor
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-2 border-b border-line/60 px-5 py-3">
        <ScissorsIcon />
        <h1 className="text-sm font-medium">Edit Clip</h1>
        <span className="ml-2 truncate text-xs text-ink-muted" title={clipPath}>
          {clipPath.split(/[\\/]/).pop()}
          {info && info.fileSize > 0 ? ` · ${formatBytes(info.fileSize)}` : ''}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black/40">
          <div className="relative">
            {previewError ? (
              <div className="flex max-w-[26rem] flex-col items-center gap-1.5 p-6 text-center">
                <p className="text-[13px] text-danger">Preview unavailable</p>
                <p className="text-[11px] text-ink-muted">{previewError}</p>
                <p className="text-[11px] text-ink-faint">
                  Cutting still works. Use the timeline to cut and delete pieces.
                </p>
              </div>
            ) : (
              <VideoPreview
                videoRef={videoRef}
                src={clipUrl(info.previewPath)}
                onTimeUpdate={onTimeUpdate}
                onDurationChange={(d) => {
                  if (duration === 0 && d > 0) setDuration(d)
                }}
                onPlayStateChange={onPlayStateChange}
                onError={setPreviewError}
              />
            )}

            {/* Transport overlay: the video has no native controls, so playback needs
                an explicit control or the element is effectively frozen. */}
            {!previewError && (
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors hover:bg-black/20"
              >
                <span
                  className={
                    'flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white transition-opacity ' +
                    (playing ? 'opacity-0 hover:opacity-100' : 'opacity-90')
                  }
                >
                  {playing ? (
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg className="ml-1 h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
                    </svg>
                  )}
                </span>
              </button>
            )}

            {/* A gap under the playhead is black on the timeline and black on screen:
                the file holds black frames there. */}
            {!previewError && gapHere ? <div className="pointer-events-none absolute inset-0 bg-black" /> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={!!saving || !!cutBlocked}
              onClick={cut}
              title={cutBlocked ?? 'Split the piece at the playhead (C)'}
            >
              Split
            </Button>
            <Button
              variant={range ? 'primary' : 'secondary'}
              size="sm"
              disabled={!!saving || (selected.length === 0 && !range)}
              onClick={() => (range ? cutOut() : removeSelected('ripple'))}
              title={
                range
                  ? `Remove the marked ${rangeLabel(range.to - range.from)} and close the gap (Delete)`
                  : 'Take the selected piece out and close the sequence up behind it (Delete)'
              }
            >
              {range ? `Cut out ${rangeLabel(range.to - range.from)}` : 'Cut out'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!!saving || selected.length === 0}
              onClick={() => removeSelected('lift')}
              title="Take the selected piece out and leave black in its place (Shift+Delete)"
            >
              Lift
            </Button>
            <span className="mx-1 h-4 w-px bg-line/60" />
            <Button variant="ghost" size="sm" disabled={!!saving || history.past.length === 0} onClick={undo} title="Undo (Ctrl+Z)">
              Undo
            </Button>
            <Button variant="ghost" size="sm" disabled={!!saving || history.future.length === 0} onClick={redo} title="Redo (Ctrl+Shift+Z)">
              Redo
            </Button>
            <Button variant="ghost" size="sm" disabled={!!saving || !edited} onClick={reset} title="Keep the whole clip again (R)">
              Reset
            </Button>
            <span className="mx-1 h-4 w-px bg-line/60" />
            <Button
              variant={snap ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setSnap((v) => !v)}
              title="Snap the playhead to cuts and piece edges (S)"
            >
              Snap {snap ? 'on' : 'off'}
            </Button>
            <input
              className="tabular ml-1 w-[8.75rem] rounded border border-line/60 bg-canvas px-1.5 py-0.5 text-[11px] text-ink"
              aria-label="Playhead timecode"
              value={tcDraft ?? formatTimecode(currentSec, fps)}
              onChange={(e) => setTcDraft(e.target.value)}
              onBlur={() => {
                if (tcDraft === null) return
                const at = readTimecode(tcDraft)
                if (Number.isFinite(at)) seek(at)
                setTcDraft(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') setTcDraft(null)
              }}
            />
            <span className="text-[11px] text-ink-faint">/ {formatTimecode(shape.duration, fps)}</span>
            <span className="flex-1" />
            {cutNotice ? (
              <span className="text-[11px] text-ink-muted">{cutNotice}</span>
            ) : !edited ? (
              <span className="text-[11px] text-ink-faint">Drag across the timeline to mark footage, then Cut out</span>
            ) : null}
          </div>

          <Timeline
            duration={duration}
            shape={shape}
            currentSec={currentSec}
            fps={fps}
            selected={selected}
            range={range}
            snap={snap}
            onSeek={seek}
            onSelect={select}
            onRange={pickRange}
            onTrimStart={onTrimStart}
            onTrim={onTrim}
            onTrimEnd={onTrimEnd}
          />

          {tracks.length > 0 ? (
            <>
              <MasterVolumeRow
                value={masterVolume}
                onChange={setMasterVolume}
                peaks={masterPeaks ?? undefined}
                contentSec={shape.duration}
                selection={selectionSpan}
                currentSec={currentSec}
                duration={duration}
                onSeek={seek}
              />
              <div className="flex flex-col gap-1">
                {tracks.map((track) => (
                  <AudioTrackLane
                    key={track.stream}
                    label={track.label}
                    peaks={splicedPeaks[track.stream]}
                    volume={volumes[track.stream] ?? 1}
                    contentSec={shape.duration}
                    selection={selectionSpan}
                    currentSec={currentSec}
                    duration={duration}
                    onSeek={seek}
                    onVolumeChange={(v) => setVolumes((prev) => ({ ...prev, [track.stream]: v }))}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="text-center text-[11px] text-ink-faint">No audio loaded</p>
          )}

          <div className="tabular flex items-center justify-between pt-1 text-[11px] text-ink-faint">
            <span>
              {formatTimecode(currentSec, fps)} / {formatTimecode(shape.duration, fps)}
            </span>
            <span>{summary}</span>
          </div>

          <ExportSection
            clipPath={clipPath}
            startSec={exportSpan?.startSec ?? 0}
            endSec={exportSpan?.endSec ?? 0}
            duration={duration}
            fileSize={info.fileSize}
            busy={!!saving}
            scope={
              exportSpan
                ? exportSpan.fromSelection
                  ? 'the selected piece'
                  : 'the piece under the playhead'
                : 'nothing under the playhead'
            }
          />

          {saveError ? <p className="text-[11px] text-danger">{saveError}</p> : null}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line/60 px-4 py-2.5">
        <p className="flex-1 text-[11px] text-ink-faint">
          {saveState.ok
            ? volumesChanged
              ? 'Audio volumes changed — the clip will be re-encoded.'
              : gapCount
                ? 'A gap is written as black and silence — this save re-encodes.'
                : 'Cuts on keyframes save as a stream copy.'
            : saveState.error}
        </p>
        {/* The save runs for as long as ffmpeg needs; without a moving bar the
            footer and the disabled buttons look like a frozen window. */}
        {saving ? <ProgressBar label="Saving the clip" className="w-32 shrink-0" /> : null}
        <Button variant="secondary" disabled={!!saving} onClick={close} title="Close the editor (Escape clears the selection first)">
          Close
        </Button>
        <Button
          variant="primary"
          disabled={!!saving || !saveState.ok}
          onClick={() => void save('copy')}
          title="Writes the edit to a new file beside the clip; the original is kept"
        >
          {saving?.mode === 'copy' ? 'Saving…' : 'Save a copy'}
        </Button>
        <Button
          variant="danger"
          disabled={!!saving || !saveState.ok}
          onClick={() => setConfirmReplace(true)}
          title="Writes the edit over the original clip. Asks before replacing it."
        >
          {saving?.mode === 'overwrite' ? 'Saving…' : 'Replace original'}
        </Button>
      </footer>

      <Dialog
        open={confirmReplace}
        title="Replace the original clip?"
        onClose={() => setConfirmReplace(false)}
        dismissible={!saving}
        footer={
          <>
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => setConfirmReplace(false)} disabled={!!saving}>
              Keep original
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              disabled={!!saving}
              onClick={() => {
                setConfirmReplace(false)
                void save('overwrite')
              }}
            >
              Replace original
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">
          The edited clip will overwrite <span className="text-ink">{clipPath.split(/[\\/]/).pop()}</span>. The original
          cannot be recovered.
        </p>
      </Dialog>
    </div>
  )
}

/**
 * Compress: a smaller MP4 copy of the selected range, at the source's resolution.
 *
 * Each Quality chip is a fraction of the original clip's own bitrate — the point
 * of compressing is to reduce, so the ask is always below what the source spent
 * and the file can never come out larger. Discord instead names a size: the
 * free upload limit, which the encode is held under rather than aimed at. The
 * readout shows the size that bitrate produces and the exact reduction against
 * the original clip.
 */
function ExportSection({
  clipPath,
  startSec,
  endSec,
  duration,
  fileSize,
  busy,
  scope,
}: {
  clipPath: string
  startSec: number
  endSec: number
  duration: number
  fileSize: number
  busy: boolean
  /** Which piece the section will act on, in words, for the header line. */
  scope: string
}) {
  /** Fraction of the source's own bitrate each quality chip encodes at. */
  const QUALITY_FRACTIONS = { low: 0.4, medium: 0.65, high: 0.9 } as const
  type Quality = keyof typeof QUALITY_FRACTIONS
  /**
   * Discord's free upload limit is 50 MB, in the same MB this app counts in, and
   * the goal keeps a hair under it rather than landing on the line.
   */
  const DISCORD_MAX_MB = 49.9
  /** A goal is a quality fraction, or an absolute size a share needs to fit. */
  type Goal = Quality | 'discord'
  const [goal, setGoal] = useState<Goal>('medium')
  const [running, setRunning] = useState(false)
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null)
  // Off by default: the box collapses to its title, out of the way of the cut work
  // it sits under, and only opens when the user asks for a compressed copy.
  const [compressOn, setCompressOn] = useState(false)

  useEffect(() => {
    return api.on('export-progress', (p) => setPercent(p.percent))
  }, [])

  const exportLength = Math.max(0, endSec - startSec)

  /*
   * The size model: each quality chip encodes at a fraction of the source's own
   * bitrate (video = fraction − 128 kbps of audio, floored at 200). The Discord
   * goal instead spends whatever bitrate lands the file on DISCORD_MAX_MB, but
   * never more than High: a share goal exists to reduce, not to inflate a clip
   * that already fits. The readout and the target the encoder receives are the
   * same arithmetic, so the file lands on the number shown. On very low-bitrate
   * sources the 200 kbps floor can exceed the fraction — the percent readout
   * says so honestly.
   */
  const srcKbps = fileSize > 0 && duration > 0 ? (fileSize * 8) / duration / 1000 : 0
  /** The bitrate below which an export cannot express anything watchable. Mirrors main/export.ts. */
  const FLOOR_KBPS = 200
  // The validator caps an export at 500 MB; keep the ask inside it instead of
  // letting a long range produce a number the button then refuses.
  const cap500Kbps = exportLength > 0 ? Math.max(200, (500 * 8 * 1024) / exportLength - 129) : Infinity
  /** Video bitrate for a fraction of the source's own, above the watchable floor. */
  const kbpsFor = (fraction: number) => Math.max(FLOOR_KBPS, Math.floor(srcKbps * fraction) - 128)
  /** What the Discord ceiling can spend on this range's video, before the floor. */
  const discordFit = Math.floor((DISCORD_MAX_MB * 8 * 1024) / Math.max(exportLength, 1)) - 128
  const discordKbps = Math.max(FLOOR_KBPS, discordFit)
  /** A range too long for 49.9 MB at a watchable bitrate: the goal is not reachable. */
  const discordFits = discordFit >= FLOOR_KBPS
  const goalKbps =
    goal === 'discord'
      ? Math.min(discordKbps, kbpsFor(QUALITY_FRACTIONS.high))
      : kbpsFor(QUALITY_FRACTIONS[goal])
  const videoKbps = Math.min(goalKbps, cap500Kbps)
  // +129, not +128: main recomputes the video bitrate from this target with a
  // floor at 200, and one kbps of headroom keeps the roundtrip above the floor.
  const estMb = Math.max(0.1, ((videoKbps + 129) * exportLength) / 8 / 1024)

  // The exact reduction against the original clip's size.
  const baselineMb = fileSize / 1024 / 1024
  const savedPct = baselineMb > 0 ? ((baselineMb - estMb) / baselineMb) * 100 : 0
  const savingsLine =
    baselineMb <= 0
      ? null
      : savedPct > 0
        ? `${Math.round(savedPct)}% smaller`
        : savedPct < 0
          ? `${Math.abs(Math.round(savedPct))}% larger`
          : 'same size'

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setPercent(0)
    try {
      // Always a copy in the Compressed folder; the original is never overwritten.
      const req = {
        clipPath,
        startSec,
        endSec,
        targetMb: Math.max(0.1, ((videoKbps + 129) * exportLength) / 8 / 1024),
        // A share limit is a ceiling, not an average: main measures the encode
        // and tries lower when a single-pass GPU run overshoots it.
        ...(goal === 'discord' ? { maxMb: DISCORD_MAX_MB } : {}),
      }
      const res = await api.editorExport(req)
      if (!res.success || !res.data) {
        setError(res.success ? 'Export failed' : res.error)
      } else {
        setResult({ path: res.data.path, bytes: res.data.bytes })
      }
    } catch (e) {
      setError(messageOf(e, 'Export failed'))
    } finally {
      setRunning(false)
    }
  }

  const exportDisabledReason =
    exportLength < 1
      ? 'Nothing to compress here — put the playhead on a piece, or select one'
      : goal === 'discord' && !discordFits
        ? `This range cannot fit ${DISCORD_MAX_MB} MB at a watchable bitrate — trim it or pick a quality`
        : running
          ? 'An export is already running'
          : null
  const discordBlocked = goal === 'discord' && !discordFits

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface px-3 py-2" data-testid="export-section">
      {/* The settings line fills the width and drops its action to a second,
          right-aligned line when the two no longer fit beside each other. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[12px] font-medium">Compress</span>
        <span className="truncate text-[11px] text-ink-faint" data-testid="export-scope">
          on {scope}
        </span>
        <button
          type="button"
          aria-pressed={compressOn}
          data-testid="compress-toggle"
          title={compressOn ? 'Hide the compressor' : 'Show the compressor'}
          onClick={() => setCompressOn(!compressOn)}
          className={cn(
            'rounded border px-2 py-0.5 text-[11px] transition-colors',
            compressOn
              ? 'border-accent/60 bg-accent/10 text-ink'
              : 'border-line text-ink-muted hover:text-ink',
          )}
        >
          {compressOn ? 'On' : 'Off'}
        </button>
        {compressOn ? (
          <>
            <span className="text-[11px] text-ink-muted">Quality</span>
            {(Object.keys(QUALITY_FRACTIONS) as Quality[]).map((label) => (
              <button
                key={label}
                type="button"
                disabled={running}
                data-testid={`goal-${label}`}
                title={`${Math.round(QUALITY_FRACTIONS[label] * 100)}% of the clip's bitrate`}
                onClick={() => setGoal(label)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] capitalize transition-colors',
                  goal === label
                    ? 'border-accent/60 bg-accent/10 text-ink'
                    : 'border-line text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
            <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
            <button
              type="button"
              disabled={running}
              aria-pressed={goal === 'discord'}
              data-testid="goal-discord"
              title={`Compress to fit Discord's 50 MB free upload limit (${DISCORD_MAX_MB} MB target)`}
              onClick={() => setGoal('discord')}
              className={cn(
                'rounded border px-2 py-0.5 text-[11px] transition-colors',
                goal === 'discord'
                  ? 'border-accent/60 bg-accent/10 text-ink'
                  : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              Discord
            </button>
            <span className="tabular text-[11px] text-ink-muted" data-testid="size-readout">
              {discordBlocked
                ? `won't fit ${DISCORD_MAX_MB} MB`
                : `≈ ${estMb < 10 || goal === 'discord' ? estMb.toFixed(1) : Math.round(estMb)} MB`}
            </span>
            {savingsLine && !discordBlocked ? (
              <span className="tabular text-[11px] text-accent">{savingsLine}</span>
            ) : null}

            {/* The action takes the end of the settings line, or a line of its
                own when there is no room beside them. */}
            <span className="ml-auto" title={exportDisabledReason ?? undefined}>
              <Button
                variant="primary"
                size="sm"
                data-testid="export-button"
                disabled={busy || running || exportLength < 1 || discordBlocked}
                onClick={() => void run()}
              >
                Compress to new file
              </Button>
            </span>
          </>
        ) : null}
      </div>

      {(running || result) && (
        <div className="mt-1 flex flex-nowrap items-center gap-x-3 overflow-hidden">
          <span className="truncate text-[11px] text-ink-faint">
            Writes a smaller copy to the Compressed folder — the original is untouched.
          </span>
          {running ? (
          <>
            <span className="tabular shrink-0 text-[11px] text-ink-muted">{percent}%</span>
            <ProgressBar percent={percent} label="Export progress" className="w-32 shrink-0" />
            <Button variant="ghost" size="sm" onClick={() => void api.editorExportCancel()}>
              Cancel
            </Button>
          </>
        ) : null}
        {result ? (
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-ink-muted">
            <span className="truncate">
              Saved <span title={result.path}>{result.path.split(/[\\/]/).pop()}</span> ({formatBytes(result.bytes)})
            </span>
            <Button variant="ghost" size="sm" onClick={() => void api.showClipInFolder(result.path)}>
              Show in folder
            </Button>
          </span>
        ) : null}
        </div>
      )}
      {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}
    </div>
  )
}

/**
 * The timeline: the sequence as a strip of pieces, and where every edit starts.
 *
 * Drawn from the same `Layout` the writer runs from (@shared/cut.js), so a piece, a
 * cut tick, a gap and the length on screen are the edit that will be written, never a
 * second opinion about it. The x scale is the *source* clip, so the strip shrinks to
 * the left as pieces come out and the empty track past the end is space the edit no
 * longer uses. A cut is drawn as a tick where the source runs on; where it does not --
 * a piece the user deleted, or one they lifted -- the break is drawn as a seam.
 */
function Timeline({
  duration,
  shape,
  currentSec,
  fps,
  selected,
  range,
  snap,
  onSeek,
  onSelect,
  onRange,
  onTrimStart,
  onTrim,
  onTrimEnd,
}: {
  /** Source length: the x scale. */
  duration: number
  shape: Layout
  currentSec: number
  fps: number
  selected: number[]
  /** The stretch marked for Cut out, in output seconds. */
  range: { from: number; to: number } | null
  snap: boolean
  onSeek: (outSec: number) => void
  onSelect: (ids: number[]) => void
  onRange: (next: { from: number; to: number } | null) => void
  onTrimStart: () => void
  onTrim: (items: Item[]) => void
  onTrimEnd: () => void
}) {
  const laneRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<
    { kind: 'playhead' } | { kind: 'head' } | { kind: 'tail' } | { kind: 'range'; anchor: number; at: number; startX: number } | null
  >(null)
  const [hoverSec, setHoverSec] = useState<number | null>(null)
  /** Set when a press turned into a drag, so the click that follows does not seek or select. */
  const movedRef = useRef(false)

  const total = duration > 0 ? duration : 1
  const items = useMemo(() => shape.spans.map((s) => s.item), [shape])

  /** Everything a cut could sensibly land on: the ends of the sequence, and its seams. */
  const targets = useMemo(() => [0, shape.duration, ...shape.spans.flatMap((s) => [s.outIn, s.outOut])], [shape])

  const toSeconds = useCallback(
    (clientX: number): number => {
      const rect = laneRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return 0
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const raw = ratio * total
      const framed = snapToFrame(raw, fps)
      if (!snap) return framed
      // A magnet about eight pixels wide: wide enough to catch a seam, narrow enough
      // to leave the rest of the clip reachable.
      const radius = total * 0.012
      let best = framed
      let bestDist = Infinity
      for (const target of targets) {
        const dist = Math.abs(target - raw)
        if (dist <= radius && dist < bestDist) {
          bestDist = dist
          best = snapToFrame(target, fps)
        }
      }
      return best
    },
    [total, fps, snap, targets],
  )

  /** Raises or lowers the open edge of the first piece: the head of the clip. */
  const trimHead = useCallback(
    (outT: number) => {
      const first = shape.spans[0]
      if (!first || first.item.kind !== 'keep') return
      const item = first.item
      const at = snapToFrame(
        Math.max(0, Math.min(item.srcIn + (outT - first.outIn), item.srcOut - MIN_SEGMENT_SEC)),
        fps,
      )
      onTrim([{ ...item, srcIn: at }, ...items.slice(1)])
    },
    [shape, items, fps, onTrim],
  )

  /** The same, at the other end of the last piece. */
  const trimTail = useCallback(
    (outT: number) => {
      const last = shape.spans[shape.spans.length - 1]
      if (!last || last.item.kind !== 'keep') return
      const item = last.item
      const at = snapToFrame(
        Math.min(total, Math.max(item.srcIn + MIN_SEGMENT_SEC, item.srcOut + (outT - last.outIn))),
        fps,
      )
      onTrim([...items.slice(0, -1), { ...item, srcOut: at }])
    },
    [shape, items, total, fps, onTrim],
  )

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const t = toSeconds(e.clientX)
      if (drag.kind === 'playhead') onSeek(Math.min(t, shape.duration))
      else if (drag.kind === 'head') trimHead(t)
      else if (drag.kind === 'tail') trimTail(t)
      else {
        // Five pixels is a click with a shaky hand, not a marked range.
        if (Math.abs(e.clientX - drag.startX) > 5) movedRef.current = true
        setDrag({ ...drag, at: Math.min(t, shape.duration) })
      }
    }
    const onUp = () => {
      if (drag.kind === 'range') {
        const from = Math.min(drag.anchor, drag.at)
        const to = Math.max(drag.anchor, drag.at)
        onRange(movedRef.current && to - from >= MIN_SEGMENT_SEC ? { from, to } : null)
      } else if (drag.kind !== 'playhead') {
        onTrimEnd()
      }
      setDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, toSeconds, shape.duration, onSeek, onTrimEnd, trimHead, trimTail, onRange])

  /*
   * Wheel scrub: scroll up rewinds, scroll down advances. The first notch lands
   * immediately, so a single scroll responds at once; the rest coalesce into one
   * seek per animation frame, because the wheel fires far faster than a seek can
   * land -- the same unthrottled-seek lesson that ended the rail's hover scrub.
   */
  const pendingRef = useRef<number | null>(null)
  const lastRef = useRef<number | null>(null)
  const wheelRafRef = useRef<number | null>(null)
  const currentRef = useRef(currentSec)
  currentRef.current = currentSec

  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return
    const flush = () => {
      wheelRafRef.current = null
      const target = pendingRef.current
      pendingRef.current = null
      // The chain dies with its frame: once the playhead has moved, the next
      // scroll continues from wherever the video actually is, not from a stale
      // scrub target.
      lastRef.current = null
      if (target !== null) onSeek(target)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const step = (e.deltaY || e.deltaX) / 100 // one notch ≈ 1 second
      const base = pendingRef.current ?? lastRef.current ?? currentRef.current
      const next = Math.max(0, Math.min(shape.duration, base + step))
      if (wheelRafRef.current !== null) {
        // A frame is already queued: ride along with it.
        pendingRef.current = next
        return
      }
      // Leading edge: same-frame events chain from this value.
      lastRef.current = next
      onSeek(next)
      wheelRafRef.current = requestAnimationFrame(flush)
    }
    lane.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      lane.removeEventListener('wheel', onWheel)
      if (wheelRafRef.current !== null) cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
      pendingRef.current = null
      lastRef.current = null
    }
  }, [shape.duration, onSeek])

  // Ruler labels: a step that leaves at most eight of them whatever the clip's length.
  const step = useMemo(() => [1, 2, 5, 10, 15, 30, 60, 300].find((s) => total / s <= 8) ?? 600, [total])
  const ticks = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i * step <= shape.duration + 1e-6; i++) out.push(Number((i * step).toFixed(3)))
    return out
  }, [shape.duration, step])

  /*
   * What the seams mean. Two pieces that meet where the source carries on are a cut:
   * one clip became two with nothing in between. Any other break -- a piece taken
   * out, or a piece lifted -- is a jump in the source, and the seconds it skips are
   * worth saying out loud.
   */
  const seams = useMemo(
    () =>
      shape.spans.slice(0, -1).map((span, i) => {
        const next = shape.spans[i + 1]
        const keeps = span.item.kind === 'keep' && next.item.kind === 'keep'
        const srcOut = span.item.kind === 'keep' ? span.item.srcOut : null
        const removedSec =
          keeps && span.item.kind === 'keep' && next.item.kind === 'keep'
            ? Math.max(0, next.item.srcIn - span.item.srcOut)
            : next.item.kind === 'gap'
              ? next.item.durSec
              : 0
        return {
          at: span.outOut,
          cut: keeps && removedSec < 0.001,
          srcOut,
          removedSec,
        }
      }),
    [shape],
  )

  const playheadPct = pct(currentSec, total)
  const first = shape.spans[0]
  const last = shape.spans[shape.spans.length - 1]
  const titled = 'Scroll to scrub · click to seek · drag to mark a range · click a piece to select · drag its edge to trim'
  const liveRange =
    drag?.kind === 'range'
      ? { from: Math.min(drag.anchor, drag.at), to: Math.max(drag.anchor, drag.at) }
      : range

  return (
    <div className="flex flex-col">
      <div className="relative ml-0.5 mr-0.5 h-4 text-[10px] text-ink-faint" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute top-0 -translate-x-1/2" style={{ left: `${pct(t, total)}%` }}>
            {formatDuration(t)}
          </span>
        ))}
      </div>

      <div
        ref={laneRef}
        role="slider"
        tabIndex={0}
        title={titled}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(shape.duration)}
        aria-valuenow={Math.round(currentSec)}
        aria-valuetext={`${formatTimecode(currentSec, fps)} of ${formatTimecode(shape.duration, fps)}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          movedRef.current = false
          const at = Math.min(toSeconds(e.clientX), shape.duration)
          setDrag({ kind: 'range', anchor: at, at, startX: e.clientX })
        }}
        onClick={(e) => {
          if (movedRef.current) {
            movedRef.current = false
            return
          }
          onSelect([])
          onRange(null)
          onSeek(Math.min(toSeconds(e.clientX), shape.duration))
        }}
        onMouseMove={(e) => setHoverSec(toSeconds(e.clientX))}
        onMouseLeave={() => setHoverSec(null)}
        onKeyDown={(e) => {
          // A control that declares `role="slider"` has to answer to the keyboard.
          // Dragging needs a pointer, so this moves the playhead, which is what the
          // lane's own affordance is for.
          const frame = fps > 0 ? 1 / fps : 0.02
          const stepSec = e.shiftKey ? 1 : frame
          if (e.key === 'ArrowRight') onSeek(currentSec + stepSec)
          else if (e.key === 'ArrowLeft') onSeek(currentSec - stepSec)
          else if (e.key === 'Home') onSeek(0)
          else if (e.key === 'End') onSeek(shape.duration)
          else return
          e.preventDefault()
        }}
        className="relative h-9 cursor-pointer select-none rounded bg-raised/40"
      >
        {shape.spans.map((span) => {
          const item = span.item
          const isGap = item.kind === 'gap'
          const picked = selected.includes(item.id)
          const length = span.outOut - span.outIn
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={picked}
              data-testid={isGap ? 'timeline-gap' : 'timeline-piece'}
              onClick={(e) => {
                e.stopPropagation()
                if (movedRef.current) {
                  movedRef.current = false
                  return
                }
                // Shift extends: two pieces can be taken out in one delete.
                if (e.shiftKey) {
                  onSelect(picked ? selected.filter((id) => id !== item.id) : [...selected, item.id])
                } else {
                  onSelect([item.id])
                }
              }}
              title={
                isGap
                  ? `Gap · ${formatDuration(item.durSec)} of black and silence (Shift+Delete put it here)`
                  : `Piece · ${formatTimecode(item.srcIn, fps)} → ${formatTimecode(item.srcOut, fps)} in the clip`
              }
              style={{
                left: `${pct(span.outIn, total)}%`,
                width: `${pct(length, total)}%`,
                minWidth: 2,
                ...(isGap
                  ? {
                      backgroundImage:
                        'repeating-linear-gradient(45deg, rgba(148,163,184,0.22) 0 3px, transparent 3px 7px)',
                    }
                  : null),
              }}
              className={cn(
                'absolute inset-y-1 overflow-hidden rounded border text-left transition-colors',
                isGap
                  ? 'border-dashed border-line/70 text-ink-faint hover:border-line'
                  : picked
                    ? 'border-accent/70 bg-accent/25 text-ink'
                    : 'border-line/60 bg-raised/80 text-ink-muted hover:bg-raised',
              )}
            >
              <span className="block truncate px-1 text-[10px] leading-[1.4rem]">
                {isGap
                  ? `gap ${formatDuration(item.durSec)}`
                  : item.srcIn < 0.001
                    ? formatDuration(item.srcOut)
                    : `${formatDuration(item.srcIn)}→${formatDuration(item.srcOut)}`}
              </span>
            </button>
          )
        })}

        {/* What Cut out will take: the stretch the pointer marked, drawn over the pieces
            so the selection reads against the footage it will remove. */}
        {liveRange && liveRange.to - liveRange.from >= MIN_SEGMENT_SEC ? (
          <div
            data-testid="timeline-range"
            className="pointer-events-none absolute inset-y-0 border-x-2 border-accent bg-accent/20"
            style={{
              left: `${pct(liveRange.from, total)}%`,
              width: `${pct(liveRange.to - liveRange.from, total)}%`,
            }}
          />
        ) : null}

        {/* The seams, drawn over the pieces: a tick where the source runs on, a dashed
            marker where it jumps. */}
        {seams.map((seam) => (
          <div
            key={seam.at}
            className={cn(
              'pointer-events-none absolute inset-y-0 w-px',
              seam.cut ? 'bg-ink/70' : 'border-l border-dashed border-accent/70',
            )}
            style={{ left: `${pct(seam.at, total)}%` }}
            title={
              seam.cut
                ? `Cut · ${formatTimecode(seam.srcOut ?? 0, fps)}`
                : seam.removedSec > 0
                  ? `Seam · ${formatDuration(seam.removedSec)} removed here`
                  : 'Seam'
            }
          />
        ))}

        {hoverSec !== null && !drag ? (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-ink/25" style={{ left: `${pct(hoverSec, total)}%` }} />
        ) : null}

        <div className="pointer-events-none absolute inset-y-0 w-px bg-ink" style={{ left: `${playheadPct}%` }} />
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            setDrag({ kind: 'playhead' })
          }}
          title={`Playhead — ${formatTimecode(currentSec, fps)} · drag to scrub`}
          className="absolute top-0 h-2.5 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-sm bg-ink"
          style={{ left: `${playheadPct}%` }}
        />

        {/* The open edges of the edit: the only two places there is outside footage to
            trim against. Inside the sequence a piece edge is a cut, not a handle. */}
        {first?.item.kind === 'keep' ? (
          <div
            onMouseDown={(e) => {
              e.stopPropagation()
              onTrimStart()
              setDrag({ kind: 'head' })
            }}
            title={`Start of the clip — ${formatTimecode(first.item.srcIn, fps)} · drag to trim`}
            className="absolute inset-y-0 -left-1.5 w-1.5 cursor-ew-resize rounded-l bg-accent/70 hover:bg-accent"
          />
        ) : null}
        {last?.item.kind === 'keep' ? (
          <div
            onMouseDown={(e) => {
              e.stopPropagation()
              onTrimStart()
              setDrag({ kind: 'tail' })
            }}
            title={`End of the clip — ${formatTimecode(last.item.srcOut, fps)} · drag to trim`}
            className="absolute inset-y-0 w-1.5 cursor-ew-resize rounded-r bg-accent/70 hover:bg-accent"
            style={{ left: `${pct(shape.duration, total)}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Overall clip loudness, on the same lane shape as the per-track rows.
 *
 * The master volume is kept separate from the per-track values rather than folded
 * into them, so moving the master does not overwrite what the user set per track:
 * the two multiply at save time. Its waveform is the loudest of the tracks at each
 * point, so the row reads as the shape of the whole mix without decoding it again.
 */
function MasterVolumeRow({
  value,
  onChange,
  peaks,
  contentSec,
  selection,
  currentSec,
  duration,
  onSeek,
}: {
  value: number
  onChange: (v: number) => void
  /** Loudest of the tracks at each point — the shape of the whole mix. */
  peaks?: number[]
  contentSec: number
  selection: { startSec: number; endSec: number } | null
  currentSec: number
  duration: number
  onSeek: (t: number) => void
}) {
  const shown = value

  return (
    // Same grid as AudioTrackLane, cell for cell: label 20, waveform, slider 20,
    // readout 9. The label cell stays the same width so the waveform and slider
    // start at the same x as the Desktop and Microphone rows.
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-xs text-ink-muted">Clip</span>
      <LaneGraph
        label="Clip volume"
        peaks={peaks}
        contentSec={contentSec}
        selection={selection}
        currentSec={currentSec}
        duration={duration}
        onSeek={onSeek}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(shown * 100)}
        aria-label="Clip volume"
        title="Applies to every audio track, on top of each track's own volume."
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-1 w-20 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />
      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">{Math.round(shown * 100)}%</span>
    </div>
  )
}

/**
 * The waveform lane shared by every audio row: the peak envelope, the piece the
 * selection covers, and the playhead, clickable to seek.
 *
 * The envelope is the sequence's, not the source's: the peaks arrive already cut to
 * match the pieces (@shared/cut.js's splicePeaks), so the lane ends where the picture
 * does and the space past the end is the footage the edit no longer uses. A lane that
 * still showed the removed audio would read as though the cuts had not been applied.
 */
function LaneGraph({
  label,
  peaks,
  contentSec,
  selection,
  currentSec,
  duration,
  onSeek,
}: {
  label: string
  peaks?: number[]
  /** Where the sequence ends: the waveform spans this much of the lane. */
  contentSec: number
  selection: { startSec: number; endSec: number } | null
  currentSec: number
  duration: number
  onSeek: (t: number) => void
}) {
  const laneRef = useRef<HTMLDivElement>(null)

  const toSeconds = useCallback(
    (clientX: number) => {
      const el = laneRef.current
      if (!el) return 0
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return 0
      return Math.max(0, Math.min(contentSec, ((clientX - r.left) / r.width) * duration))
    },
    [duration, contentSec],
  )

  const contentPct = pct(contentSec, duration)
  const playheadPct = pct(currentSec, duration)

  return (
    <div
      ref={laneRef}
      role="slider"
      tabIndex={0}
      aria-label={`${label} playhead`}
      aria-valuemin={0}
      aria-valuemax={Math.round(contentSec)}
      aria-valuenow={Math.round(currentSec)}
      aria-valuetext={`${formatDuration(currentSec)} of ${formatDuration(contentSec)}`}
      onClick={(e) => onSeek(toSeconds(e.clientX))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1
        if (e.key === 'ArrowRight') onSeek(Math.min(contentSec, currentSec + step))
        else if (e.key === 'ArrowLeft') onSeek(Math.max(0, currentSec - step))
        else return
        e.preventDefault()
      }}
      className="relative h-8 flex-1 cursor-pointer overflow-hidden rounded bg-raised/40"
    >
      {/* The waveform is only as wide as the sequence: past it is footage the edit
          no longer holds. */}
      <div className="absolute inset-y-0 left-0" style={{ width: `${contentPct}%` }}>
        {peaks && peaks.length > 0 ? (
          <Waveform peaks={peaks} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-ink-muted">
            No waveform data
          </div>
        )}
      </div>

      {/* The footage the edit no longer uses, dimmed to match the empty track on the
          video timeline. */}
      {contentPct < 100 ? (
        <div
          className="absolute inset-y-0 right-0 bg-canvas/60"
          style={{ width: `${Math.max(0, 100 - contentPct)}%` }}
          title={`Beyond the end of the edit — ${formatDuration(Math.max(0, duration - contentSec))} of the source is not in the file`}
        />
      ) : null}

      {/* The selection, matching the video timeline's highlight. */}
      {selection ? (
        <div
          className="pointer-events-none absolute inset-y-0 border-x border-accent/60 bg-accent/10"
          style={{
            left: `${pct(selection.startSec, duration)}%`,
            width: `${Math.max(0, pct(selection.endSec, duration) - pct(selection.startSec, duration))}%`,
          }}
        />
      ) : null}

      {/* Same playhead as the video lane, so the two read as one timeline. */}
      <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${playheadPct}%` }} />
    </div>
  )
}

/** One audio track: a label, a volume slider, and its peak envelope. */
function AudioTrackLane({
  label,
  peaks,
  volume,
  contentSec,
  selection,
  currentSec,
  duration,
  onSeek,
  onVolumeChange,
}: {
  label: string
  peaks?: number[]
  volume: number
  contentSec: number
  selection: { startSec: number; endSec: number } | null
  currentSec: number
  duration: number
  onSeek: (t: number) => void
  onVolumeChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-xs text-ink-muted">{label}</span>
      <LaneGraph
        label={label}
        peaks={peaks}
        contentSec={contentSec}
        selection={selection}
        currentSec={currentSec}
        duration={duration}
        onSeek={onSeek}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume * 100)}
        aria-label={`${label} volume`}
        onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
        className="h-1 w-20 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong accent-accent"
      />
      <span className="tabular w-9 shrink-0 text-right text-[11px] text-ink-faint">
        {Math.round(volume * 100)}%
      </span>
    </div>
  )
}

/**
 * Peak envelope as mirrored bars.
 *
 * The engine returns one bucket per audio frame — about two thousand for a
 * forty-second clip — which is several times more bars than the lane has pixels.
 * Rendering them all gave each bar a 1px floor plus a 1px gap, so the envelope
 * compressed into a dotted hairline and the waveform told you nothing. The bars
 * are reduced to what the lane can actually show, keeping the tallest peak in each
 * pixel, so a transient is never averaged away by the quiet around it.
 */
function Waveform({ peaks }: { peaks: number[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A bar plus its 1px gap occupies two pixels, so that is the real budget.
  const budget = Math.max(1, Math.floor(width / 2))
  const bars = useMemo(() => {
    if (peaks.length <= budget) return peaks
    const step = peaks.length / budget
    const out: number[] = []
    for (let i = 0; i < budget; i++) {
      const from = Math.floor(i * step)
      const to = Math.max(from + 1, Math.floor((i + 1) * step))
      let tallest = 0
      for (let j = from; j < to && j < peaks.length; j++) tallest = Math.max(tallest, peaks[j])
      out.push(tallest)
    }
    return out
  }, [peaks, budget])

  /*
   * Normalise against the loudest bar, so the waveform uses the lane's height.
   *
   * Absolute amplitude is the wrong scale here. A quiet recording peaks around
   * 0.02-0.07, which is 2-7% of the lane -- and the 2px floor below then pins
   * almost every bar to the same stubby height, which reads as a flat line rather
   * than as quiet audio. Dividing by the maximum keeps the *shape*, which is what
   * a waveform is for, and makes a quiet clip legible instead of blank.
   *
   * A floor on the divisor stops a near-silent clip from being stretched into a
   * dramatic-looking waveform out of noise.
   */
  const { shaped, loudest } = useMemo(() => {
    let max = 0
    for (const p of bars) if (p > max) max = p
    const scale = Math.max(max, 0.05)
    return { shaped: bars.map((p) => Math.min(1, p / scale)), loudest: max }
  }, [bars])

  return (
    <div ref={ref} className="flex h-full items-center gap-px px-1">
      {shaped.map((peak, i) => (
        <div
          key={i}
          className="min-w-px flex-1 rounded-sm bg-accent/50"
          style={{ height: `${Math.max(2, peak * 100)}%` }}
          title={`Peak ${Math.round(peak * 100)}% of the loudest sample in this track`}
        />
      ))}
      {/* Peak level is the one number worth showing: after normalising, the
          waveform no longer tells you whether the recording was quiet or loud. */}
      {loudest > 0 ? (
        <span className="ml-1.5 shrink-0 self-start text-[9px] tabular-nums text-ink-muted">
          peak {loudest < 0.01 ? '<1' : Math.round(loudest * 100)}%
        </span>
      ) : null}
    </div>
  )
}

function ScissorsIcon() {
  return (
    <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88" />
      <path d="M14.47 14.48 20 20" />
      <path d="M8.12 8.12 12 12" />
    </svg>
  )
}