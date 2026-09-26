# Changelog

## 1.6.0 — 2026-09-26 (Desktop 1.1.0)

### Cloud sync replaces the recovery-key vault

Signing in is now all a device needs: history, dictionary, and analytics sync through the WoVoice account, with no recovery key, vault setup, or key transfer between devices.

- **Worker:** new `/v2/sync` API. Records are encrypted by the Worker before they reach D1, using a per-account data key wrapped by the new `SYNC_KEK` secret (envelope encryption with rotation through `SYNC_KEK_PREVIOUS` and `SYNC_KEK_VERSION`). Per-account limits: 10,000 history, 20,000 analytics, and 1,000 dictionary records. Retention runs on the scheduled job. Deploy with migration `0006_cloud_sync.sql` and `npx wrangler secret put SYNC_KEK`.
- **Account choices:** **Sync history** (turning it off deletes the account's cloud history and keeps local copies) and **Auto-delete history** (30 days, 90 days, 1 year, or never, applied on every device).
- **Moving off the vault:** a device that still holds a vault key imports the vault once, tells the server, and deletes the key. After that, v1 sync answers `426 UPGRADE_REQUIRED` for that account, and its old ciphertext is purged 30 days later. `SYNC_V1_SUNSET_AT` closes v1 for everyone.
- **Removed:** recovery keys and their QR codes, the Android camera permission and QR scanner library, the desktop Touch ID key reveal and vault reset, and vault setup screens.
- The Privacy Policy and Terms describe cloud sync (policy version `2026-09-26-cloud-sync`), and both apps show a one-time notice.

### Worker

- Completing or releasing a quota reservation no longer aborts when a quota grant lapses or is cleared while the day's usage is above the base limit. Before, the stuck reservation broke every scheduled maintenance run. Apply migration `0005_quota_growth_only_triggers.sql` before deploying.
- Scheduled maintenance steps now run independently. Settled quota reservations are pruned after 90 days.
- The polish reservation now covers a whole cleanup call, so the global daily neuron budget records actual usage instead of under-counting it.
- A sync batch that names the same record twice is rejected with 400. Before, it failed as a conflict that could never be resolved.
- When the cleanup model answers with an unexpected JSON key (for example `{"cleaned_transcript": …}`) or cut-off JSON, the raw ASR text is used. Before, the JSON itself was pasted into the user's text field.
- `/v1/health` no longer uses up the 10-per-minute recording limit. Code verification is rate-limited per client address, and a challenge that has used its five attempts is rejected without another database write.
- A moderation email that fails to send gives its slot in the monthly email budget back.

### Android

- Dictating after typed text such as "Hello. " now starts a new sentence, and the keyboard's shift follows.
- The legacy glossary is imported once instead of on every launch and dictation. The repeated import leaked dictionary terms between accounts and brought back terms deleted on another device.
- An edit made while a sync upload is in flight is no longer marked synced and lost. An access token that expires during an upload is refreshed once.
- "Clear all data" revokes the server session before it removes the refresh token.
- "Reset analytics" on one device now lowers the daily totals on your other devices, and corrections now sync.
- A dictionary term added separately on two devices, or renamed onto an existing term, no longer drops the synced copy or stalls sync.
- Sync downloads come in smaller pages, so a page of large records can no longer overflow the response limit and stall sync.
- The "Clear history" and "Reset analytics" confirmations now say when the deletion also reaches your other synced devices.

### Desktop 1.1.0

- Sync no longer loops on conflicts after an upload whose response was lost. That loop also blocked every later upload.
- A dictionary term renamed on the phone no longer breaks all future syncs.
- History Undo works: the deletion waits for the undo window, and Undo withdraws the pending deletion.
- Recordings that hit the 60-second limit are transcribed instead of being discarded.
- A revoked session now signs the app out instead of failing every request. An expired token is refreshed and the request retried once.
- Signing in to a different account removes the previous account's local data after you confirm, so the two accounts' records never mix.
- The Accessibility status reads the real permission, and the quota reset time and the "polished" label display correctly.
- Downsampling to 16 kHz filters high frequencies first, which reduces aliasing on sibilants.
- Databases created by builds before sync existed are now upgraded. Before, every sync on those Macs failed with "no such column: syncId", and adding a dictionary term failed.
- Signing in on a Mac whose local data has an unknown owner asks whether to keep that data or remove it.
- The recording bubble and the Home tab name the trigger key you chose, instead of always "⌥". Only one copy of the app can open the database, and a `wovoice://` link that launches the app is no longer lost.

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
