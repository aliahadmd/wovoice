# Typeless Android comparison

Installed build inspected on 2026-11-01; WoVoice implementation and verification continued on 2026-11-02.

For the subsequent rich-editor and Xiaomi background investigation, including newer validation results, see [Android bubble reliability](android-bubble-reliability.md).

## Evidence and scope

- Device: USB-connected Redmi K80 Pro, Android API 37. Installed package `com.typeless.mobile`, version `2.10.0`, version code `359`, minimum API 24 and target API 36. Identity was read from Android's package manager.
- The pulled base APK has SHA-256 `23c1e25423254797a839d8a2914c75bec9cc80500bd6a6ffe46731db6f5b3a9e`. REA inventoried its container entries: parent Evidence `ev_4c55b698012026cbce9f0cd2f7a0d1325d5ead884b32a767a3af7b21fa7f6af0`, summary `ev_b02d825983330ca9c1708e83f68caed5c9fb30d0164eece246f6a4099d9e1e9d`. This establishes packaged resources, not their execution.
- A live Settings screenshot was captured by REA: Evidence `ev_59d4d3e61ebe93eb544948f0236c0670bf68b5a63cf8b3701e0b27745a05693f`. Settings navigation also exposed the Typeless bubble entry, haptics, translation targets, language variants, and appearance controls. Personal history and account contents were not investigated.
- A live Typeless recording completed with Gboard selected on November 2. A generated spoken sentence, “This is a short dictation test.”, was inserted into an isolated test application's focused empty field. Other fields were preserved. REA captured idle Evidence `ev_0610aa64ddd9c1377f2cbf1152b265170637771c32568f3b4ff4b8987552f07e` and result Evidence `ev_53557af9a0e05e748891abf3fec5e565e76a1a41133a23eef90902765532b112`. A local screen recording showed live bars, Thinking, and the return to idle. The idle control also shrank/dimmed near the screen edge. This establishes one live flow on this device.
- Typeless's [official Android bubble release notes](https://www.typeless.com/help/release-notes/android/dictate-with-typeless-bubble), dated October 28, 2026, describe keeping another keyboard selected, tapping to start/finish, and setup for overlay, Accessibility, and background access.
- The APK's own tutorial video, `res/raw/src_assets_videos_permission_voice_bubble_how_it_works.mp4` (8.48 seconds), and gesture GIF, `res/drawable-mdpi-v4/src_assets_images_keyboard_voice_bubble_swipe_guide.gif` (9 seconds), were inspected frame by frame. These are shipped demonstrations; they do not establish exact runtime timing on every device.
- Android SDK manifest inspection observed microphone/foreground-service, overlay, and battery-optimization permissions, plus a service protected by `BIND_ACCESSIBILITY_SERVICE`. This establishes declarations, not permission enforcement or actual data handling.

Research artifacts are local under `/tmp/wovoice-typeless-research/`. The APK and proprietary assets are not part of this repository. WoVoice uses its own microphone drawing, colors, and native view implementation.

## Bubble observations and resulting changes

| Evidence | Typeless observation or WoVoice gap | WoVoice change |
| --- | --- | --- |
| Shipped tutorial video/GIF | Small idle control, live bars, expanded processing label | Compact microphone, five separated bars, and a short transition into Thinking |
| Shipped tutorial video/GIF | Recording and processing are visibly distinct | Elapsed recording time and one-minute limit, distinct live/static/processing states |
| WoVoice source | Entire label was disabled during processing, preventing dragging | Processing suppresses the recording action while retaining drag handling |
| Live Typeless Settings + WoVoice source | Haptics are a preference; WoVoice's bubble ignored its existing preferences | Bubble follows haptic, animation, waveform, and system animator settings |
| WoVoice source | Failure feedback was a transient Toast and lost the recording immediately | Persistent status with Open app/Speak again, plus bounded Retry for temporary upload failures |
| WoVoice source and Android TextView/InputFilter implementation | Whole-field Accessibility replacement can be truncated by a declared character limit, removing an existing suffix | Check the proposed complete value against `maxTextLength` before mutation; platform fixture tests preserve existing text and selection |
| WoVoice source | Every screen update restarted a debounce deadline | One pending refresh is scheduled, so busy interfaces cannot postpone the bubble indefinitely |
| WoVoice source | Screen-off cancellation relied on subsequent Accessibility events | Explicit screen-off cancellation and an interactive-screen check |
| Live comparison and local microphone measurements | WoVoice intermittently classified the generated sample as silence; Android reported its `VOICE_RECOGNITION` stream was not silenced, while Typeless used `MIC` | Prefer `MIC`, retaining `VOICE_RECOGNITION` as an initialization fallback; keep the shared silence thresholds unchanged |
| Live keyboard bounds + WoVoice source | Overlay positions use usable-window coordinates, while keyboard bounds use screen coordinates | Account for the status-bar inset; dragging down stops above Gboard with an 8 dp gap |

The WoVoice gaps are observations about this codebase. They are not claims about Typeless's private implementation.

## Retry and insertion constraints

A temporary failure offers at most two explicit retries within one minute of the first failure. Retrying never extends that deadline. Temporary audio is deleted on completion, expiry, cancellation, a changed editor/text/selection, a changed account, screen-off, service destruction, or starting a new recording. Expiry also cancels an in-flight retry. Existing text and source-app identity are not uploaded.

Insertion still requires the original focused, enabled, visible, non-password editor with unchanged text and selection. It never falls back to the clipboard or another field. The length check covers limits exposed through Accessibility; custom input filters that do not declare a maximum remain an interoperability limitation. Apps that do not expose a usable editable node are unsupported.

WoVoice uses an Accessibility overlay. Its working overlay path does not require adding Typeless's separate overlay or battery-optimization permission requests.

## Other product opportunities

The inspected Typeless Settings also exposes multiple keyboard layouts, interface language, translation targets, language variants, and appearance. WoVoice already has History, Dictionary, analytics, account sync, manual typing, haptics, and waveform settings. Translation and localization would require a separate language/output contract and backend validation; they were not added to this Android bubble change. WoVoice's documented speech scope remains English (India). Typeless's automatic idle dimming/edge compaction is another possible refinement; WoVoice currently keeps a visible close control.

## WoVoice validation

- The Android build and 58 JVM tests passed: 20 app tests and 38 shared tests, with no failures or errors. Android lint reported zero errors. Seven phone tests passed: six focused-editor safety/interoperability cases and one native presentation/interaction test. The presentation test was also rerun independently to verify its foreground-launch setup.
- The editor cases cover preserving another field, refusing changed text/selection or another target, blocking passwords, ignoring empty-field hints, refusing overflow before changing existing text, and replacing a selection exactly at its declared length limit.
- The presentation test covers compact idle controls, recording timer, processing action suppression with dragging, Retry action, cancel, retained editor focus/cursor, and static rendering when motion/waveform are disabled. Its motion preview uses a synthetic signal; it does not claim microphone or server coverage.
- Real WoVoice dictation independently inserted “This is a short bubble dictation test.” into the focused empty field while Gboard remained selected. The first, second, password, and length-limited fields were unchanged. Both the previous microphone source and the updated one completed a live transcription; the previous source also intermittently failed the local silence gate.
- For the same generated phrase played through the Mac speakers, a `VOICE_RECOGNITION` sample measured RMS `0.00110`, peak frame RMS `0.00324`, and 512 ms above the detector's activity threshold. The `MIC` sample measured RMS `0.01323`, peak frame RMS `0.03810`, and 2,560 ms active. The roughly 12-fold RMS difference supports preferring `MIC` on this phone; it is not a gain guarantee for other hardware. Android's audio diagnostics reported the previous stream was not silenced. No silence thresholds or desktop capture logic changed.
- A downward drag clamped WoVoice's window bottom to screen y=2030 while Gboard's touchable region began at y=2060: a 30 px / 8 dp gap at this device's density. The bubble position was moved back after checking. The public Accessibility setup action remains available even when Android already reports the service enabled, allowing users to reconnect it after a process restart.

Only generated test speech was copied locally for numeric signal analysis, and those audio copies were deleted afterward. The temporary test APK and presentation snapshots were removed, and the phone's original sleep setting was restored. No production audio logging or retained-audio feature was introduced.

## Limits of this investigation

- REA's Android class/method decompiler was unavailable because the caller-supplied JADX MCP JAR was not configured. The two React Native bundles in the APK are Hermes bytecode, not recovered JavaScript source. No claim is made about private algorithms, network internals, or complete feature coverage.
- Live Typeless and WoVoice flows were verified in an isolated native editor fixture on one phone. This is not a compatibility claim for every third-party app, device, Bluetooth route, or concurrent microphone client. The bounded Retry model is unit tested; an actual network-outage retry was not exercised on the phone.
- WoVoice's presentation test uses synthetic signal levels to exercise native rendering and controls without recording or uploading audio. This is separate from a real microphone or cloud-transcription test.
