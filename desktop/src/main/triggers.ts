import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export type Trigger = 'keyboard' | 'middle-click'

interface TriggerSettings {
  keyboardShortcutEnabled: boolean
  middleClickEnabled: boolean
  triggerKey: string
}

// Raw macOS virtual keycodes (kVK_*) for each selectable trigger key.
export const TRIGGER_KEYS: readonly string[] = [
  'option',
  'option-right',
  'command',
  'command-right',
  'caps-lock',
  'fn'
]

const TRIGGER_KEY_CODES: Record<string, number[]> = {
  option: [58], // left Option — default
  'option-right': [61],
  command: [55], // left Command
  'command-right': [54],
  'caps-lock': [57],
  fn: [63] // Globe key
}

const TRIGGER_KEY_LABELS: Record<string, string> = {
  option: '⌥',
  'option-right': 'right ⌥',
  command: '⌘',
  'command-right': 'right ⌘',
  'caps-lock': '⇪',
  fn: 'fn'
}

/** What ends a recording started by `trigger`, for the overlay's hint line. */
export function releaseHint(trigger: Trigger, triggerKey: string): string {
  if (trigger === 'middle-click') return 'Release the middle button'
  return `Release ${TRIGGER_KEY_LABELS[triggerKey] ?? '⌥'}`
}

// CGEvent mouse button number for the center/middle button.
const MOUSE_MIDDLE = 2

/**
 * Global triggers via tapd, the bundled self-healing event-tap helper:
 * hold the configured trigger key to dictate, quick-tap to latch (start; tap
 * again to stop), and hold middle-click for the same. Runs as a child process
 * so macOS's tap-timeout disablement can never silently kill dictation — the
 * helper re-enables its own tap. Needs only the Accessibility (Device Control
 * & Data Access) grant; events are not suppressed.
 */
export class TriggerEngine {
  private lock = false
  private keyDownAt = 0
  private keyboardLatched = false
  private triggerDown = false
  private latchStopPress = false
  private helper: ChildProcess | null = null
  private activeCodes: number[] = []
  private pendingLine = ''

  constructor(
    private readonly settings: TriggerSettings,
    private readonly onStart: (trigger: Trigger) => void,
    private readonly onStop: (trigger: Trigger) => void
  ) {}

  private codes(): number[] {
    const preset = TRIGGER_KEY_CODES[this.settings.triggerKey] ?? TRIGGER_KEY_CODES.option
    return [...preset]
  }

  private helperPath(): string {
    const packaged = join(process.resourcesPath, 'tapd')
    if (existsSync(packaged)) return packaged
    return join(__dirname, '../../native/tapd')
  }

  register(): void {
    if (this.helper !== null) return
    this.activeCodes = this.codes()
    try {
      const child = spawn(this.helperPath(), this.activeCodes.map(String), {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      child.stdout?.setEncoding('utf-8')
      this.pendingLine = ''
      child.stdout?.on('data', (chunk: string) => {
        // A pipe read can end mid-line; a split "k 58 " + "1" used to parse as a
        // key-up (stopping the session) and drop the key-down that followed.
        const lines = (this.pendingLine + chunk).split('\n')
        this.pendingLine = lines.pop() ?? ''
        for (const line of lines) {
          const [kind, value, state] = line.trim().split(' ')
          if (kind === 'k') this.onKeyLine(Number(value), state === '1')
          else if (kind === 'm') this.onMouseLine(Number(value), state === '1')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text.length > 0) console.log('[trigger][tapd]', text)
      })
      child.on('exit', (code) => {
        if (this.helper === child) {
          this.helper = null
          console.log('[trigger] tapd exited with code', code)
        }
      })
      // spawn() reports ENOENT/permissions failures asynchronously — without
      // this listener the error throws in the main process and isRegistered()
      // would keep reporting a healthy helper that never ran.
      child.on('error', (error) => {
        if (this.helper === child) this.helper = null
        console.error('[trigger] tapd failed to run:', error)
      })
      this.helper = child
      console.log('[trigger] tap started (tapd), keycodes', this.activeCodes.join(', '))
    } catch (error) {
      console.error('[trigger] registration failed:', error)
      this.helper = null
    }
  }

  restart(): void {
    this.unregister()
    this.register()
  }

  isRegistered(): boolean {
    return this.helper !== null && this.helper.exitCode === null
  }

  registerIfMissing(): void {
    if (!this.isRegistered()) this.register()
  }

  unregister(): void {
    if (this.helper === null) return
    this.helper.kill()
    this.helper = null
    // A restarted helper cannot know whether the key is still down; assume up so
    // a stale "down" doesn't swallow the next real press.
    this.triggerDown = false
    this.reset()
  }

  /**
   * Forgets the latch after a session ended without a trigger stop (Esc, the
   * overlay's cancel button, the 60 s cap). The physical key state is kept so a
   * still-held key's release is not mistaken for a new quick tap.
   */
  reset(): void {
    this.lock = false
    this.keyboardLatched = false
    this.latchStopPress = this.triggerDown
  }

  private onKeyLine(keycode: number, down: boolean): void {
    if (down) this.onKeyDown(keycode)
    else this.onKeyUp(keycode)
  }

  private onMouseLine(button: number, down: boolean): void {
    if (down) this.onMouseDown(button)
    else this.onMouseUp(button)
  }

  private tryStart(trigger: Trigger): boolean {
    if (this.lock) return false
    this.lock = true
    this.onStart(trigger)
    return true
  }

  private tryStop(trigger: Trigger): boolean {
    if (!this.lock) return false
    this.lock = false
    this.onStop(trigger)
    return true
  }

  private onKeyDown(keycode: number): void {
    if (!this.settings.keyboardShortcutEnabled || !this.activeCodes.includes(keycode)) {
      return
    }
    // Key auto-repeat fires extra keydowns while the key is held: only the
    // first one opens a session, so the last repeat can't be mistaken for a
    // quick tap at release time.
    if (this.triggerDown) return
    this.triggerDown = true
    if (this.keyboardLatched) {
      this.keyboardLatched = false
      // This press IS the stop tap — its keyup must not start a new latch.
      this.latchStopPress = true
      this.tryStop('keyboard')
      return
    }
    this.keyDownAt = Date.now()
    this.tryStart('keyboard')
  }

  private onKeyUp(keycode: number): void {
    if (!this.settings.keyboardShortcutEnabled || !this.activeCodes.includes(keycode)) {
      return
    }
    if (!this.triggerDown) return
    this.triggerDown = false
    if (this.keyboardLatched) return
    if (this.latchStopPress) {
      // Releasing the tap that stopped a latched session — do nothing.
      this.latchStopPress = false
      return
    }
    const held = Date.now() - this.keyDownAt
    if (held < 300) {
      // Quick tap: keep recording in latch mode until the next tap.
      this.keyboardLatched = true
    } else {
      this.tryStop('keyboard')
    }
  }

  private onMouseDown(button: number): void {
    if (!this.settings.middleClickEnabled || button !== MOUSE_MIDDLE) return
    this.tryStart('middle-click')
  }

  private onMouseUp(button: number): void {
    if (!this.settings.middleClickEnabled || button !== MOUSE_MIDDLE) return
    this.tryStop('middle-click')
  }
}
