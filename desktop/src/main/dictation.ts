import { BrowserWindow } from 'electron'
import { join } from 'path'
import { WorkerError } from './worker'
import { pasteText } from './insert'

export interface DictationDeps {
  settings: { workerUrl: string }
  getToken: () => Promise<string>
  getGlossary: () => Promise<string[]>
  transcribe: (
    token: string,
    wav: Buffer,
    glossary: string[]
  ) => Promise<{ text: string; polished: boolean; asrModel: string; requestId: string }>
  recordHistory: (entry: {
    text: string
    asrModel: string
    requestId: string
    durationMs: number
    polished: boolean
  }) => void
}

/**
 * Owns the overlay window and the dictation state machine:
 * begin → overlay records → end → WAV → transcribe → paste → result label.
 */
export class DictationService {
  private overlay: BrowserWindow | null = null
  private recording = false
  private processing = false

  constructor(private readonly deps: DictationDeps) {}

  private ensureOverlay(): BrowserWindow {
    if (this.overlay !== null && !this.overlay.isDestroyed()) return this.overlay
    this.overlay = new BrowserWindow({
      width: 460,
      height: 96,
      show: false,
      x: 0,
      y: 64,
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
    this.overlay.setPosition(0, 64)
    void this.overlay.loadFile(join(__dirname, '../renderer/overlay.html'))
    return this.overlay
  }

  begin(): void {
    if (this.recording || this.processing) return
    const overlay = this.ensureOverlay()
    overlay.showInactive()
    this.recording = true
    this.label('Listening… (release or tap to stop)')
    overlay.webContents.send('overlay:begin')
  }

  end(): void {
    if (!this.recording) return
    this.recording = false
    this.processing = true
    this.label('Transcribing…')
    this.overlay?.webContents.send('overlay:end')
  }

  cancel(): void {
    this.recording = false
    this.processing = false
    this.hide()
  }

  fail(message: string): void {
    this.processing = false
    this.recording = false
    this.label(message)
    setTimeout(() => {
      if (!this.recording && !this.processing) this.hide()
    }, 3200)
  }

  private label(text: string): void {
    this.overlay?.webContents.send('overlay:label', text)
  }

  private hide(): void {
    this.overlay?.hide()
  }

  /** Called by the overlay once its WAV is ready. */
  async handleCapture(payload: {
    wav: ArrayBuffer
    durationMs: number
    containsSpeech: boolean
  }): Promise<void> {
    try {
      if (!payload.containsSpeech) {
        this.finishWith('No clear speech — try again', true)
        return
      }
      this.label('Transcribing…')
      const token = await this.deps.getToken()
      const glossary = await this.deps.getGlossary()
      const outcome = await this.deps.transcribe(token, Buffer.from(payload.wav), glossary)
      await pasteText(outcome.text)
      this.deps.recordHistory({
        text: outcome.text,
        asrModel: outcome.asrModel,
        requestId: outcome.requestId,
        durationMs: payload.durationMs,
        polished: outcome.polished
      })
      this.finishWith(`✓ ${outcome.text.slice(0, 140)}`, false)
    } catch (error) {
      if (error instanceof WorkerError && (error.code === 'AUTH_REQUIRED' || error.code === 'HTTP_401')) {
        this.finishWith('Sign in to use voice dictation', true)
        return
      }
      const message = error instanceof WorkerError ? error.message : 'Dictation error'
      this.finishWith(message, true)
    }
  }

  private finishWith(message: string, isError: boolean): void {
    this.processing = false
    this.label(message)
    setTimeout(() => {
      if (!this.recording && !this.processing) this.hide()
    }, isError ? 3200 : 2000)
  }
}
