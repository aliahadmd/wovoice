import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { WorkerError } from './worker'
import { pasteText } from './insert'
import { playSound } from './sounds'
import { ContextReader, restrictContext, type ContextLevel, type ContextStyle, type ContextTarget, type DictationContext } from './context'
import { contextLabel } from '../../../worker/src/context'
import { DictationSession } from './dictation-session'

export interface DictationDeps {
  settings: { workerUrl: string; contextLevel: ContextLevel; contextStyle: ContextStyle; contextOwner: string }
  getToken: () => Promise<string>
  /** Drops a cached access token the Worker rejected so getToken() refreshes. */
  invalidateToken: (token: string) => void
  getGlossary: () => Promise<string[]>
  transcribe: (
    token: string,
    wav: Buffer,
    glossary: string[],
    context?: DictationContext,
    sentenceStart?: boolean
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
  | { state: 'transcribing'; contextLabel?: string }
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
  private readonly contextReader = new ContextReader()
  private readonly sessions = new DictationSession()
  private sessionId = 0
  private contextTarget: Promise<ContextTarget> | null = null
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
    this.contextReader.prepare()
  }

  /** ⌥Space hotkey: tap toggles (start; tap again to stop). */
  toggle(): void {
    if (this.recording) this.end()
    else if (!this.processing) this.begin()
  }

  /** `releaseHint` names what ends the recording, e.g. "Release ⌘". */
  begin(releaseHint = 'Release ⌥'): void {
    if (this.recording || this.processing) return
    this.sessionId = this.sessions.begin(this.deps.settings.contextOwner)
    this.contextTarget = this.contextReader.capture(this.deps.settings.contextLevel, this.deps.settings.contextStyle)
    console.log('[dictation] begin')
    const overlay = this.ensureOverlay()
    overlay.showInactive()
    this.recording = true
    playSound('start')
    this.sendToOverlay(overlay, 'overlay:begin', releaseHint, this.sessionId)
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
    if (this.recording || this.processing) {
      this.sessions.invalidate()
      this.contextReader.dispose()
      this.contextTarget = null
      this.processing = false
      this.clearWatchdog()
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
  onAccountChanged(): void {
    if ((this.recording || this.processing) && !this.sessions.active(this.sessionId, this.deps.settings.contextOwner)) {
      this.cancel()
      this.deps.onSessionAborted?.()
    }
  }

  matchesSession(id: number): boolean { return id === this.sessionId && this.sessions.active(id, this.deps.settings.contextOwner) }

  autoStop(): void {
    if (!this.recording) return
    console.log('[dictation] 60-second limit reached')
    this.end()
    this.deps.onSessionAborted?.()
  }

  dispose(): void { this.cancel(); this.contextReader.dispose() }

  cancel(): void {
    this.sessions.invalidate()
    this.contextReader.dispose()
    this.contextTarget = null
    this.recording = false
    this.processing = false
    this.clearWatchdog()
    this.releaseEscape()
    this.hide()
  }

  fail(message: string): void {
    this.sessions.invalidate()
    this.contextReader.dispose()
    this.contextTarget = null
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
    sessionId: number
    wav: ArrayBuffer
    durationMs: number
    containsSpeech: boolean
  }): Promise<void> {
    // Only accept a WAV for a session that actually reached "processing" —
    // a stale capture from a cancelled session must never be transcribed.
    if (!this.processing || !this.sessions.claim(payload.sessionId, this.deps.settings.contextOwner)) {
      console.log('[dictation] ignoring capture — no active session')
      return
    }
    const sessionId = payload.sessionId
    const active = (): boolean => this.processing && this.sessions.active(sessionId, this.deps.settings.contextOwner)
    const targetPromise = this.contextTarget
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
      const target = await targetPromise
      if (!active()) return
      if (!target?.token) { this.fail(target?.reason === 'accessibility' ? 'Allow Accessibility access for WoVoice in Settings, then try again.' : 'This editor does not expose a safe insertion target. Select a supported text box and try again.'); return }
      const context = (): DictationContext | undefined => {
        const captured = restrictContext(target.context, this.deps.settings.contextLevel)
        return captured ? { ...captured, style: this.deps.settings.contextStyle } : undefined
      }
      this.sendState({ state: 'transcribing', contextLabel: contextLabel(context()) })
      let outcome: Awaited<ReturnType<DictationDeps['transcribe']>>
      try {
        outcome = await this.deps.transcribe(token, wav, glossary, context(), target.sentenceStart)
      } catch (error) {
        // A token the server no longer accepts (expired early, or rotated away)
        // gets one refresh-and-retry, as on the phone, before failing the dictation.
        const rejected =
          error instanceof WorkerError &&
          (error.code === 'TOKEN_EXPIRED' || error.code === 'AUTH_REQUIRED')
        if (!rejected) throw error
        if (!active()) return
        this.deps.invalidateToken(token)
        const refreshed = await this.deps.getToken()
        if (!active()) return
        outcome = await this.deps.transcribe(refreshed, wav, glossary, context(), target.sentenceStart)
      }
      // Never log the transcript itself — stdout is a plaintext voice memo.
      console.log('[dictation] transcribed:', outcome.text.length, 'chars')
      if (!active()) return
      await pasteText(outcome.text, async () => active() && await this.contextReader.validate(target.token) && active())
      if (!active()) return
      this.contextReader.dispose()
      this.contextTarget = null
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
      if (!active()) return
      // Error payloads can contain provider or editor details: do not log them.
      console.error('[dictation] request or insertion failed')
      if (error instanceof WorkerError && (error.code === 'AUTH_REQUIRED' || error.code === 'HTTP_401')) {
        this.fail('Sign in to use voice dictation')
        return
      }
      const message = error instanceof WorkerError ? error.message : error instanceof Error && error.message === 'EDITOR_CHANGED' ? 'The text box or cursor changed. Nothing was inserted; speak again in the intended field.' : 'Dictation error — try again'
      this.fail(message)
    }
  }
}
