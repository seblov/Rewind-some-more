import { useEffect, useState } from 'react'
import { Copy, Minus, Settings as SettingsIcon, Square, X } from 'lucide-react'
import { api } from '../lib/api'
import { GitHubIcon } from './brand-icons'
import { RewindMark } from './mark'
import { ThemeButton } from './theme-button'
import { UpdateButton } from './update-button'
import { cn } from './ui'

/** Where the titlebar's community links go. */
const GITHUB_URL = 'https://github.com/seblov/Rewind-some-more'

/**
 * The window's own bar.
 *
 * The window is frameless. On Windows a native `titleBarOverlay` draws the real
 * caption buttons at the top-right and keeps snap layouts, the window menu and
 * double-click-to-maximize working. Linux draws no overlay, so this bar supplies
 * the caption buttons itself and drops the 150px reserve they need.
 *
 * The bar is the drag region. Anything clickable inside it opts out with
 * `no-drag`, or the window swallows the click.
 */
export function Titlebar() {
  // The overlay is a Windows feature. Other platforms get the custom controls.
  const nativeOverlay = api.platform === 'win32'

  return (
    <header
      data-testid="titlebar"
      className={cn(
        'drag-region flex h-10 shrink-0 items-center gap-2 border-b border-line bg-canvas pl-3.5',
        nativeOverlay ? 'pr-[150px]' : 'pr-0',
      )}
    >
      <span className="text-accent">
        <RewindMark className="h-[18px] w-[18px]" />
      </span>
      <h1 className="text-[13px] font-semibold tracking-tight">Rewind</h1>

      <div className="no-drag ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid="titlebar-github"
          onClick={() => void api.openExternal(GITHUB_URL)}
          aria-label="GitHub"
          title="GitHub"
          className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <GitHubIcon className="h-4 w-4" />
        </button>
        <ThemeButton />
        <UpdateButton />
        <button
          type="button"
          data-testid="titlebar-settings"
          onClick={() => (window.location.hash = '/settings')}
          aria-label="Settings"
          className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <SettingsIcon className="h-4 w-4" strokeWidth={1.5} />
        </button>

        {!nativeOverlay ? (
          <>
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
            <WindowControls />
          </>
        ) : null}
      </div>
    </header>
  )
}

/**
 * Minimize, maximize/restore, and close for platforms without the native overlay.
 *
 * The glyph follows the window rather than the last click: a window manager can
 * maximize from a double-click or a tiling shortcut, so main sends every state
 * change and the button reads it. Close hides the panel to the tray, which is the
 * same thing `window.close()` already did.
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    // The panel can mount before registerIpc has run the first time; a missing
    // handler would otherwise surface as an unhandled rejection.
    void api.isWindowMaximized()
      .then((res) => {
        if (alive && res.success) setMaximized(!!res.data)
      })
      .catch(() => {})
    const off = api.on('window-state', (state) => setMaximized(state.maximized))
    return () => {
      alive = false
      off()
    }
  }, [])

  const toggleMaximize = () => {
    void api
      .toggleMaximizeWindow()
      .then((res) => {
        if (res.success) setMaximized(res.data.maximized)
      })
      .catch(() => {})
  }

  const control = 'flex h-10 w-[46px] items-center justify-center text-ink-muted transition-colors'

  return (
    <div className="flex items-center">
      <button
        type="button"
        data-testid="titlebar-minimize"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void api.minimizeWindow().catch(() => {})}
        className={cn(control, 'hover:bg-raised hover:text-ink')}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        data-testid="titlebar-maximize"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={toggleMaximize}
        className={cn(control, 'hover:bg-raised hover:text-ink')}
      >
        {maximized ? (
          <Copy className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <Square className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        data-testid="titlebar-close"
        aria-label="Close"
        title="Close to tray"
        onClick={() => void api.closeWindow().catch(() => {})}
        className={cn(control, 'hover:bg-danger-fill hover:text-white')}
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  )
}
