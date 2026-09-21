/*
 * tapd — WoVoice's global trigger tap for macOS.
 *
 * A tiny event-tap daemon spawned by the Electron main process. It reports
 * trigger events as lines on stdout ("k <keycode> <0|1>", "m <button> <0|1>")
 * for the trigger keycodes given in argv, and is self-healing: macOS disables
 * event taps whose callback misses its reply window
 * (kCGEventTapDisabledByTimeout), so both the callback and a watchdog
 * re-enable the tap. Uses a filter tap at the session level, which needs only
 * the Accessibility (Device Control & Data Access) grant — the same permission
 * model as Wispr Flow; events are returned unmodified.
 *
 * Modifier keys (Option 58/61, Command 55/54, CapsLock 57, Fn/Globe 63)
 * report press/release via kCGEventFlagsChanged with the flag bit set while
 * held. Synthetic modifiers arrive as plain key-down/up — both are handled.
 * Non-modifier keycodes (e.g. F-keys) report key-down/up directly.
 *
 * Exits when stdin closes (parent death) or on SIGTERM.
 */
#include <ApplicationServices/ApplicationServices.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_RULES 8

typedef struct {
  int code;
  int isModifier;
  CGEventFlags mask;
} KeyRule;

static KeyRule rules[MAX_RULES];
static int ruleCount = 0;
static CFMachPortRef g_tapPort = NULL;

static CGEventFlags flagMaskForCode(int code) {
  switch (code) {
    case 58: /* left Option */
    case 61: /* right Option */
      return kCGEventFlagMaskAlternate;
    case 55: /* left Command */
    case 54: /* right Command */
      return kCGEventFlagMaskCommand;
    case 57: /* CapsLock */
      return kCGEventFlagMaskAlphaShift;
    case 63: /* Fn / Globe */
      return kCGEventFlagMaskSecondaryFn;
    default:
      return 0;
  }
}

static void emit(const char *kind, long value, int down) {
  printf("%s %ld %d\n", kind, value, down);
  fflush(stdout);
}

static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void *refcon) {
  (void)proxy; (void)refcon;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (g_tapPort != NULL) CGEventTapEnable(g_tapPort, true);
    fprintf(stderr, "tapd: tap re-enabled after %u\n", type);
    return event;
  }
  if (type == kCGEventFlagsChanged) {
    int64_t kc = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);
    for (int i = 0; i < ruleCount; i++) {
      if (rules[i].isModifier && rules[i].code == kc) {
        emit("k", (long)kc, (flags & rules[i].mask) != 0);
        break;
      }
    }
    return event;
  }
  if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
    int64_t kc = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    for (int i = 0; i < ruleCount; i++) {
      if (rules[i].code == kc) {
        // Synthetic modifiers post plain key-down/up instead of
        // FlagsChanged — accept both so hardware and injected keys behave
        // identically. Hardware modifiers never emit key-down/up.
        emit("k", (long)kc, type == kCGEventKeyDown);
        break;
      }
    }
    return event;
  }
  if (type == kCGEventOtherMouseDown || type == kCGEventOtherMouseUp) {
    int64_t button = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
    if (button == 2) { // center/middle button (CGEvent numbering)
      emit("m", (long)button, type == kCGEventOtherMouseDown);
    }
    return event;
  }
  return event;
}

static void watchdog(CFRunLoopTimerRef timer, void *info) {
  (void)timer; (void)info;
  if (g_tapPort != NULL && !CGEventTapIsEnabled(g_tapPort)) {
    CGEventTapEnable(g_tapPort, true);
    fprintf(stderr, "tapd: watchdog re-enabled tap\n");
  }
}

// Exit when the parent closes our stdin (parent crash/quit safety).
static void *stdinWatch(void *unused) {
  (void)unused;
  char buf[1];
  while (read(STDIN_FILENO, buf, 1) > 0) { /* drain */ }
  exit(0);
  return NULL;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc && ruleCount < MAX_RULES; i++) {
    int code = atoi(argv[i]);
    CGEventFlags mask = flagMaskForCode(code);
    rules[ruleCount].code = code;
    rules[ruleCount].isModifier = mask != 0;
    rules[ruleCount].mask = mask;
    ruleCount++;
  }
  if (ruleCount == 0) {
    fprintf(stderr, "tapd: no trigger keycodes given\n");
    return 2;
  }

  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) |
                     CGEventMaskBit(kCGEventKeyDown) |
                     CGEventMaskBit(kCGEventKeyUp) |
                     CGEventMaskBit(kCGEventOtherMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseUp);
  g_tapPort = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                               kCGEventTapOptionDefault, mask, tapCallback, NULL);
  if (g_tapPort == NULL) {
    fprintf(stderr, "tapd: CGEventTapCreate failed (Accessibility grant missing?)\n");
    return 1;
  }
  CGEventTapEnable(g_tapPort, true);

  CFRunLoopSourceRef source =
      CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tapPort, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
  CFRelease(source);

  CFRunLoopTimerContext ctx = {0, NULL, NULL, NULL, NULL};
  CFRunLoopTimerRef watchdogTimer = CFRunLoopTimerCreate(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 2.0, 2.0, 0, 0,
      watchdog, &ctx);
  CFRunLoopAddTimer(CFRunLoopGetCurrent(), watchdogTimer, kCFRunLoopDefaultMode);

  pthread_t watcher;
  pthread_create(&watcher, NULL, stdinWatch, NULL);

  setvbuf(stdout, NULL, _IOLBF, 0);
  fprintf(stderr, "tapd: running, watching %d keycode(s)\n", ruleCount);
  CFRunLoopRun();
  return 0;
}
