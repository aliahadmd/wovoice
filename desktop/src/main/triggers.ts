import { uIOhook, UiohookKey } from 'uiohook-napi'

type Trigger = 'keyboard' | 'middle-click'

interface TriggerSettings {
  keyboardShortcutEnabled: boolean
  middleClickEnabled: boolean
}

/**
 * Global triggers via a CGEventTap (JNativeHook lineage): hold ⌥ to dictate,
 * quick-tap to latch (start; tap again to stop), and hold middle-click for the
 * same. Requires the Input Monitoring grant; events are not suppressed, which
 * is why the default key is one with no text side-effect.
 */
export class TriggerEngine {
  private lock = false
  private keyDownAt = 0
  private keyboardLatched = false

  constructor(
    private readonly settings: TriggerSettings,
    private readonly onStart: (trigger: Trigger) => void,
    private readonly onStop: (trigger: Trigger) => void
  ) {}

  register(): void {
    uIOhook.on('keydown', (event) => this.onKeyDown(Number(event.keycode)))
    uIOhook.on('keyup', (event) => this.onKeyUp(Number(event.keycode)))
    uIOhook.on('mousedown', (event) => this.onMouseDown(Number(event.button)))
    uIOhook.on('mouseup', (event) => this.onMouseUp(Number(event.button)))
    uIOhook.start()
  }

  unregister(): void {
    uIOhook.stop()
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
    if (!this.settings.keyboardShortcutEnabled || keycode !== UiohookKey.Alt) return
    if (this.keyboardLatched) {
      this.keyboardLatched = false
      this.tryStop('keyboard')
      return
    }
    this.keyDownAt = Date.now()
    this.tryStart('keyboard')
  }

  private onKeyUp(keycode: number): void {
    if (!this.settings.keyboardShortcutEnabled || keycode !== UiohookKey.Alt) return
    if (this.keyboardLatched) return
    const held = Date.now() - this.keyDownAt
    if (held < 300) {
      // Quick tap: keep recording in latch mode until the next tap.
      this.keyboardLatched = true
    } else {
      this.tryStop('keyboard')
    }
  }

  private onMouseDown(button: number): void {
    if (!this.settings.middleClickEnabled || button !== 3) return
    this.tryStart('middle-click')
  }

  private onMouseUp(button: number): void {
    if (!this.settings.middleClickEnabled || button !== 3) return
    this.tryStop('middle-click')
  }
}
