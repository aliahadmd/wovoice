import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { WorkerError } from './worker'
import { pasteText } from './insert'
import { playSound } from './sounds'

export interface DictationDeps {
  settings: { workerUrl: string }
  getToken: () => Promise<string>
  /** Drops a cached access token the Worker rejected so getToken() refreshes. */
  invalidateToken: (token: string) => void
  getGlossary: () => Promise<string[]>
  transcribe: (
    token: string,
    wav: Buffer,
    glossary: string[]
  ) => Promise<{
    text: string
    polished: boolean
    asrModel: string
    requestId: string
    timingsMs: { asr: number; polish: number; total: number }
  }>
  recordHistory: (entry: {
    text: string
    asrModel: string
    requestId: string
    durationMs: number
    polished: boolean
    timingsMs: { asr: number; polish: number; total: number }
  }) => void
  /** A session ended without the trigger being released (Esc, cancel, 60 s cap). */
  onSessionAborted?: () => void
}

export type OverlayState =
  | { state: 'transcribing' }
  | { state: 'success'; text: string; polished: boolean }
  | { state: 'error'; message: string }
  | { state: 'cancelled' }

// Pill visibility windows (the renderer mirrors these for its exit animation).
const SUCCESS_VISIBLE_MS = 2200
const ERROR_VISIBLE_MS = 3600
// Fails the session if the transcribe→paste pipeline never resolves (hung
// request, crashed renderer) — otherwise the trigger stays dead until relaunch.
const PIPELINE_TIMEOUT_MS = 120_000

/**
 * Owns the overlay window and the dictation state machine:
 * begin → overlay records → end → WAV → transcribe → paste → result label.
 * Every transition is surfaced on the pill (animated) and with a sound.
 */
export class DictationService {
  private overlay: BrowserWindow | null = null
  private recording = false
  private processing = false
  private watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: DictationDeps) {}

  private ensureOverlay(): BrowserWindow {
    if (this.overlay !== null && !this.overlay.isDestroyed()) return this.overlay
    const { workArea } = screen.getPrimaryDisplay()
    const width = 580
    const height = 120
    this.overlay = new BrowserWindow({
      width,
      height,
      show: false,
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + 56,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      center: false,
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })
    void this.overlay.loadFile(join(__dirname, '../renderer/overlay.html'))
    return this.overlay
  }

  /** Load the overlay page at startup so the first dictation isn't lost. */
  prepare(): void {
    this.ensureOverlay()
  }

  /** ⌥Space hotkey: tap toggles (start; tap again to stop). */
  toggle(): void {
    if (this.recording) this.end()
    else if (!this.processing) this.begin()
  }

  /** `releaseHint` names what ends the recording, e.g. "Release ⌘". */
  begin(releaseHint = 'Release ⌥'): void {
    if (this.recording || this.processing) return
    console.log('[dictation] begin')
    const overlay = this.ensureOverlay()
    overlay.showInactive()
    this.recording = true
    playSound('start')
    this.sendToOverlay(overlay, 'overlay:begin', releaseHint)
    // Esc cancels the in-flight recording (a global grab for a few seconds).
    const escOk = globalShortcut.register('Escape', () => this.cancelUser())
    console.log('[dictation] esc-to-cancel registered:', escOk)
  }

  end(): void {
    if (!this.recording) return
    console.log('[dictation] end — requesting WAV')
    this.recording = false
    this.processing = true
    this.releaseEscape()
    playSound('stop')
    if (this.overlay !== null) this.sendToOverlay(this.overlay, 'overlay:end')
    this.armWatchdog()
  }

  cancelUser(): void {
    if (this.recording) {
      console.log('[dictation] cancelled by user')
      this.recording = false
      this.releaseEscape()
      playSound('cancel')
      this.overlay?.webContents.send('overlay:state', {
        state: 'cancelled'
      } satisfies OverlayState)
      this.hideAfter(1600)
      // The trigger is still latched/held; without a reset the next tap only
      // "stops" this already-cancelled session and is swallowed.
      this.deps.onSessionAborted?.()
    }
  }

  /**
   * The overlay reached the 60-second cap. It used to finish on its own while
   * this service still thought it was recording, so the WAV was ignored as
   * stale and the whole dictation was lost. End the session here instead.
   */
  autoStop(): void {
    if (!this.recording) return
    console.log('[dictation] 60-second limit reached')
    this.end()
    this.deps.onSessionAborted?.()
  }

  cancel(): void {
    this.recording = false
    this.processing = false
    this.clearWatchdog()
    this.releaseEscape()
    this.hide()
  }

  fail(message: string): void {
    console.log('[dictation] fail:', message)
    this.processing = false
    this.recording = false
    this.clearWatchdog()
    this.releaseEscape()
    playSound('error')
    this.overlay?.webContents.send('overlay:state', {
      state: 'error',
      message
    } satisfies OverlayState)
    this.hideAfter(ERROR_VISIBLE_MS)
  }

  private armWatchdog(): void {
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      if (this.processing) this.fail('Dictation timed out — the service did not respond')
    }, PIPELINE_TIMEOUT_MS)
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }

  private sendState(state: OverlayState): void {
    this.overlay?.webContents.send('overlay:state', state)
  }

  private releaseEscape(): void {
    if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape')
  }

  private hide(): void {
    this.overlay?.hide()
  }

  private hideAfter(ms: number): void {
    setTimeout(() => {
      if (!this.recording && !this.processing) this.hide()
    }, ms)
  }

  /**
   * The window is created lazily on first use; a send during page load is
   * silently dropped, which would swallow the whole first dictation.
   */
  private sendToOverlay(overlay: BrowserWindow, channel: string, ...args: unknown[]): void {
    const webContents = overlay.webContents
    if (webContents.isLoading()) {
      webContents.once('did-finish-load', () => webContents.send(channel, ...args))
    } else {
      webContents.send(channel, ...args)
    }
  }

  /** Called by the overlay once its WAV is ready. */
  async handleCapture(payload: {
    wav: ArrayBuffer
    durationMs: number
    containsSpeech: boolean
  }): Promise<void> {
    // Only accept a WAV for a session that actually reached "processing" —
    // a stale capture from a cancelled session must never be transcribed.
    if (!this.processing) {
      console.log('[dictation] ignoring capture — no active session')
      return
    }
    this.armWatchdog()
    try {
      console.log(
        '[dictation] capture received:',
        payload.durationMs, 'ms, speech =', payload.containsSpeech
      )
      if (!payload.containsSpeech) {
        this.fail('No clear speech detected — try speaking a little longer')
        return
      }
      this.sendState({ state: 'transcribing' })
      const wav = Buffer.from(payload.wav)
      const glossary = await this.deps.getGlossary()
      const token = await this.deps.getToken()
      let outcome: Awaited<ReturnType<DictationDeps['transcribe']>>
      try {
        outcome = await this.deps.transcribe(token, wav, glossary)
      } catch (error) {
        // A token the server no longer accepts (expired early, or rotated away)
        // gets one refresh-and-retry, as on the phone, before failing the dictation.
        const rejected =
          error instanceof WorkerError &&
          (error.code === 'TOKEN_EXPIRED' || error.code === 'AUTH_REQUIRED')
        if (!rejected) throw error
        this.deps.invalidateToken(token)
        outcome = await this.deps.transcribe(await this.deps.getToken(), wav, glossary)
      }
      // Never log the transcript itself — stdout is a plaintext voice memo.
      console.log('[dictation] transcribed:', outcome.text.length, 'chars')
      await pasteText(outcome.text)
      console.log('[dictation] pasted')
      this.deps.recordHistory({
        text: outcome.text,
        asrModel: outcome.asrModel,
        requestId: outcome.requestId,
        durationMs: payload.durationMs,
        polished: outcome.polished,
        timingsMs: outcome.timingsMs
      })
      this.processing = false
      this.clearWatchdog()
      playSound('success')
      this.sendState({
        state: 'success',
        text: outcome.text.slice(0, 160),
        polished: outcome.polished
      })
      this.hideAfter(SUCCESS_VISIBLE_MS)
    } catch (error) {
      console.error('[dictation] failed:', error)
      if (error instanceof WorkerError && (error.code === 'AUTH_REQUIRED' || error.code === 'HTTP_401')) {
        this.fail('Sign in to use voice dictation')
        return
      }
      const message = error instanceof WorkerError ? error.message : 'Dictation error — try again'
      this.fail(message)
    }
  }
}
