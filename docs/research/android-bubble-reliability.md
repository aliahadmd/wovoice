# Android bubble reliability and rich editors

Investigated and implemented on November 2, 2026, using the connected Redmi K80 Pro (Android API 37).

## Reproduced failures

1. Closing the dashboard with Back retained the enabled, bound Accessibility service and the bubble in a separate editor app.
2. Swiping only WoVoice's card out of Recents removed its Accessibility grant, unbound the service, and hid the bubble. Android's process-exit record said `USER REQUESTED / FORCE STOP`, description `stop com.aliahad.wovoice due to SwipeUpClean`. This was a vendor task-cleanup action, not a WoVoice crash. Earlier exit records contained the same description.
3. WoVoice's Autostart was off and its app battery mode was Battery saver. Autostart was enabled and the mode changed to No restrictions through the phone's own settings. Repeating the same Recents swipe then retained the grant, bound service, and visible bubble. The combined settings were tested; their individual effects were not isolated. WoVoice was subsequently locked in Recents; the system reported `WoVoice,Locked`. Clear all was not invoked because it would affect unrelated apps.
4. A new external native-editor test showed that whole-value plain-text replacement removed bold and italic spans. The test failed before preserving the original styled text and passed afterward.
5. Real HTML dictation preserved bold, italic, and anchor markup, but the editor represented the inserted space as NBSP. An exact acknowledgement comparison incorrectly reported failure. A JVM regression test reproduced this; acknowledgement now treats NBSP and ordinary space as equivalent while pre-edit text/selection guards remain exact. Editors can also restart input after accepting a commit, so a post-commit session restart alone no longer means failure.

The user also reported that the Notes editor was working. A generated spoken test sentence was observed inserted in Notes; its subsequent false error motivated the acknowledgement fix. Automated tests otherwise use isolated test applications, not personal notes.

## Best-practice decision

Android owns the Accessibility service's binding and lifecycle. It is already a purpose-built background API. A permanently running microphone, repeated alarms, wake locks, or a second service cannot restore an Accessibility grant revoked by the OS or user. Keep the existing system-bound service and promote microphone capture to a foreground service only during recording. No always-listening mode, extra foreground-service type, boot restart loop, or secure-settings permission was added. See the [AccessibilityService lifecycle](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService) and [foreground-service guidance](https://developer.android.com/develop/background-work/services/fgs/service-types).

For this phone, configure the vendor's supported background controls. Xiaomi documents Autostart, No restrictions, and locking an app in Recents for background continuity in its [connection-protection guidance](https://www.mi.com/uk/support/faq/details/KA-700752/); its [Background App lock guide](https://www.mi.com/global/support/faq/details/KA-535435/) describes protection from Clear all. Labels vary by model. WoVoice now provides these steps and an App settings shortcut. Existing microphone and Accessibility consent remain explicit.

Force stop, Android's Active apps Stop action, turning Accessibility off, and vendor revocation remain user/system controls. The app must report disconnection and provide Reconnect, not claim it can run forever. Android documents that [stopping an app from Task Manager removes the entire app from memory](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping).

## Implemented editor path

- On API 33+, request `FLAG_INPUT_METHOD_EDITOR` and use the public [Accessibility InputMethod API](https://developer.android.com/reference/android/accessibilityservice/InputMethod). Keep Gboard or the user's chosen keyboard selected.
- Bind the insertion to the captured input-session generation, source package, focused node, exact original text, and selection. Inspect a bounded surrounding-text window off the main thread before committing. Handle editors that cannot report the window's absolute offset.
- Commit only the new fragment using [AccessibilityInputConnection.commitText](https://developer.android.com/reference/android/accessibilityservice/InputMethod.AccessibilityInputConnection), leaving surrounding HTML, links, and styles under the editor's control. The Android framework finishes the other IME's composition in the same edit batch.
- For input-connection commits, count History/analytics only after observing the expected result in the original node. An unconfirmed submitted edit gets a neutral Check text action, with no automatic second insertion that could duplicate it.
- The native fallback preserves the styled CharSequence exposed by Accessibility. Whole-document replacement is blocked for WebView content without an input connection; the keyboard picker is offered instead.
- Password/PIN, original-target, character-limit, account-change, lock-screen, and retry guards remain in effect. Apps that expose neither a useful focused node nor an input connection cannot be made universally compatible by another app. Formatting that an older editor does not expose cannot be reconstructed safely.

## Availability changes

The dashboard distinguishes actual service connection from enabled access, offers Reconnect, and checks status only while its screen is visible. The service refreshes on screen-on/unlock, input start/selection callbacks, and interrupt recovery. These are event-driven checks, with no perpetual background polling.

## Verification

- Build succeeded. All 59 JVM tests passed (21 app, 38 shared), with zero failures/errors; Android lint reported zero errors.
- All 10 phone tests passed: nine editor safety/compatibility cases and the native bubble presentation/interaction case. New cases cover styled-span preservation, partial/unknown-offset input windows, and refusing HTML whole-document replacement when no input connection is supplied. The isolated HTML fixture establishes DOM focus after page load; this avoids WebView's Accessibility CLICK reporting success without establishing input focus.
- Three real dictations completed with Gboard selected: a rich HTML contenteditable preserving bold/italic/link markup, a multiline HTML textarea leaving the rich editor unchanged, and a native styled editor that explicitly restarts input after accepting text. Each returned to the compact ready state, with no false error. The dashboard's successful-dictation count increased by exactly three.
- Focusing the native password field hid the bubble. Existing field-change, editing, hint, character-limit, and wrong-target refusal tests passed.
- The normal Back-close case passed before configuration; the formerly failing Recents swipe passed after the vendor background settings changed.
- Final device state: WoVoice Accessibility bound, no WoVoice crashed-service entry, Gboard selected, sleep/stay-awake setting unchanged at `0`, and no temporary bubble audio remaining. The test APK and test presentation snapshots were removed. Autostart, No restrictions, and WoVoice's Recents lock intentionally remain enabled.

The vendor lifecycle behavior requires a real phone check; a JVM test cannot reproduce Xiaomi's task manager. Live verification covers this one API 37 phone. API 24–32 native fallback behavior is exercised through the same fallback implementation on this phone, not on separate older hardware. Reboot, Bluetooth microphone routes, every browser/editor implementation, and long-term vendor battery cleanup have not been exhaustively tested.
