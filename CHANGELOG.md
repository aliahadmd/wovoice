# Changelog

## 1.5.1 — 2026-09-22

### Android

- Fixed the keyboard getting stuck on the processing pill when a recording was finished before the capture service connected, or when the keyboard was hidden mid-transcription.
- Fixed the delete key's hold-to-repeat continuing to delete after the keyboard view was torn down mid-press.
- The recorder no longer spins on microphone errors and now reports a failure instead of hanging silently.
- Sign-out now warns when the server session could not be revoked, and encrypted sync merges edits made on other devices instead of discarding them in a conflict.
- Records that fail to decrypt are retried after a recovery-key import instead of being skipped forever, and the local vault key is verified against the server's wrapped key before use.

### Worker

- Vault key rotation fails closed on concurrent updates instead of letting the last writer destroy the other device's wrapped key.
- Account and sync routes are rate-limited (240 requests per minute per user) and malformed session ids return 400 instead of 500.

### Desktop 1.0.1

- Cancelled dictations no longer leak the microphone or get transcribed and pasted later.
- Audio from 44.1 kHz microphones is resampled correctly (pitch-shifted recordings fixed), and the live sample rate is used for encoding.
- Sign-in can be restarted after a failed or abandoned attempt; hung network requests and stuck pastes no longer disable dictation until relaunch.
- The previous clipboard contents (text or image) are always restored after a paste, even when the paste fails.
- Builds enable hardened runtime with full entitlements and declare the Apple Events usage description required for pasting.

## 1.5.0 — 2026-08-05

- Replaced Cloudflare Access with a first-party, email-verified admin portal protected by session cookies, CSRF tokens, and a full audit trail.
- Moved public releases to a new signing identity; existing v1.3 installations must uninstall before installing this release.

## 1.4.0 — 2026-08-05

- Added the operational admin console for account moderation, quota overrides, session revocation, and service metrics.

## 1.2.0 — 2026-08-05

- Added the four-tab Home, History, Dictionary, and Settings dashboard.
- Added local dictation history, analytics, usage estimates, and personal dictionary suggestions.
- Added the speech-first Android keyboard with recording, processing, cancellation, punctuation, and focus-safe insertion.
- Added the manual QWERTY keyboard with Shift, Caps Lock, numbers, symbols, Unicode-safe delete, and editor-aware actions.
- Added encrypted device-token storage and an authenticated Cloudflare Workers AI transcription service.
- Added user documentation, screenshots, and a portfolio marketing video.
