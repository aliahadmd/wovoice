# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WoVoice is a speech-first dictation product (English, India) with three clients around one Cloudflare Worker:

| Part | Path | Stack |
| --- | --- | --- |
| Android keyboard (IME) + dashboard app | `app/` | Kotlin, Views built in code (no XML layouts/Compose), Room |
| Platform-free Kotlin core | `shared/` | Kotlin/JVM 11: Room DAO, account/session, sync engine, text policies. **Consumed only by `app/`** |
| macOS app | `desktop/` | Electron + React (electron-vite), `node:sqlite`, a C event-tap helper (`native/tapd.c`) |
| Backend + website + admin console | `worker/` | Cloudflare Worker (TypeScript), D1, Workers AI, Email Service, Turnstile; admin SPA in `worker/admin-ui/` |
| Accuracy benchmark | `benchmark/` | `node benchmark/run.mjs <audio dir>` against production with an access token |
| Marketing video | `marketing-video/` | Remotion |

`README.md` is end-user documentation (install/use), not developer docs. `CHANGELOG.md` is written for users; add an entry for user-visible changes. Versions live in `app/build.gradle.kts` (`versionName`/`versionCode`) and `desktop/package.json`; desktop releases are tagged `desktop-v<version>`.

## Commands

CI (`.github/workflows/ci.yml`) runs exactly these; use JDK 21 and Node 22.

```bash
# Android + shared
./gradlew :app:testDebugUnitTest :shared:test assembleDebug
./gradlew :shared:test --tests 'com.aliahad.wovoice.sync.SyncCoordinatorTest'          # one class
./gradlew :shared:test --tests 'com.aliahad.wovoice.sync.SyncCoordinatorTest.someName' # one test

# Worker (run inside worker/)
npm ci
npm test                 # vitest on the Workers pool + admin-ui jsdom tests
npx vitest run -t "name" # single Worker test by name (admin-ui: add --config admin-ui/vitest.config.ts)
npm run build            # builds admin SPA into public/admin/ (gitignored) + tsc checks
npm run types            # regenerate worker-configuration.d.ts after binding changes
npm run dev              # wrangler dev; needs .dev.vars (copy .dev.vars.example)

# Desktop (run inside desktop/)
npm ci
npm run typecheck && npm test && npm run lint
node --import tsx --test test/sync.test.ts   # single file
node --import tsx --test --test-name-pattern="name" test/sync.test.ts
npm run build:native     # compile native/tapd once before triggers work in `npm run dev`
npm run build:mac        # DMG in dist/

# Marketing video (inside marketing-video/)
npm run lint
```

Worker tests are fully local: `worker/wrangler.test.jsonc` + Miniflare apply the real `migrations/` to a test D1, and tests call `createHandler(services, authServices, adminServices)` with fake AI/email/Turnstile services. Never point tests at production.

Deploying the Worker (only when asked): `npx wrangler d1 migrations apply wovoice-accounts-production --remote`, then `npx wrangler deploy`. Required secrets: `AUTH_MASTER_KEY`, `PII_KEY`, `TURNSTILE_SECRET`, `SYNC_KEK` (losing `SYNC_KEK` makes all synced records unreadable).

## Architecture

### Dictation pipeline (same contract for both clients)

1. Client records **16 kHz mono 16-bit PCM WAV, ≤ 60 s**. Android: `voice/WavRecorder.kt` inside the microphone foreground service `VoiceCaptureService`. Mac: the transparent overlay window (`renderer/src/overlay/overlay.ts`) captures with Web Audio, low-pass filters, downsamples, and encodes (`lib/wav.ts`).
2. A permissive silence gate (`SpeechSignalDetector`, Kotlin in `shared/` and a TS port in `desktop/src/renderer/src/lib/speech.ts`, identical thresholds) drops near-silent recordings locally.
3. `POST /v1/transcriptions` (multipart: `audio` + JSON `options` with locale, `sentenceStart`, commands, ≤100 glossary terms). `worker/src/handler.ts`: rate limit → `validateWav` → `reserveQuota` → ASR (`models.ts`; Whisper by default, Nova-3 via `ASR_MODEL`) → `gpt-oss-20b` polish → `chooseSafePolish` (`validation.ts`) rejects polish that changes numbers, length, too many words, or looks like JSON, falling back to raw ASR text → `completeQuota` (or release in `finally`).
4. Insertion: Android commits via `InputConnection` only if the `EditorSessionGuard` generation is unchanged (late results are discarded, never inserted into another field). Mac saves the clipboard, writes text, sends ⌘V via `osascript`, and restores the clipboard (`main/insert.ts`).
5. Success is recorded locally (history + analytics) and a sync is kicked off.

### Worker

- `handler.ts` chains route handlers in order: admin → auth (`/v1/auth/*`) → account (`/v1/me*`) → legacy v1 sync (`sync.ts`, `/v1/sync*`) → v2 cloud sync (`records.ts`, `/v2/sync*`) → transcription/health. Errors are `ApiError` → `{requestId, error:{code, retryable, message}}`; clients branch on `code` (e.g. `TOKEN_EXPIRED` triggers one refresh+retry).
- **Auth**: email OTP + Turnstile → authorization code bound to a PKCE challenge → `/v1/auth/token`. Access tokens 15 min, rotating refresh tokens 30 d (reuse revokes the session), 180-day absolute session. Only HMAC hashes of tokens/codes are stored; emails are AES-GCM encrypted under `PII_KEY` with an HMAC lookup column. Android receives the code via `/app/callback` (an App Link; `assetlinks.json` is served by the Worker). The Mac runs a loopback listener (`http://127.0.0.1:<port>/callback`, requested with `platform=desktop&redirect_port=`), with the `wovoice://` deep link as a fallback.
- **Quotas and budgets are enforced by D1 triggers** (`RAISE(ABORT, 'USER_QUOTA_EXCEEDED' | 'SERVICE_DAILY_LIMIT_REACHED' | 'EMAIL_RATE_LIMITED')`) in migrations 0001/0003/0005; `limits.ts` only mirrors them. Changing a limit requires a new migration that recreates the trigger. Pricing constants in `pricing.ts` must change together with a `PRICING_VERSION` bump.
- **Cloud sync v2** (`records.ts`): clients send plain JSON payloads; the Worker seals each with a per-account AES-GCM data key (AAD = user/type/id), the data key wrapped by `SYNC_KEK` (rotation via `SYNC_KEK_PREVIOUS` + `SYNC_KEK_VERSION`, re-wrapped lazily). Optimistic concurrency: each write carries `baseVersion`; a trigger enforces `version = old + 1`; conflicts return 409 with server copies. `sync_record_changes` keeps one row per record at its latest write (the pull cursor). Per-account caps: history 10k / analytics 20k (oldest tombstoned) / dictionary 1k (refused with `STORAGE_LIMIT_REACHED`). History sync off deletes cloud history without tombstones.
- **Legacy v1 vault sync** (`sync.ts`, `sync_items`/`sync_changes`, vault columns on `users`) stays until `SYNC_V1_SUNSET_AT`; clients import it once then call `POST /v2/sync/migration`, after which v1 answers `426 UPGRADE_REQUIRED`.
- **Admin** (`admin.ts`, `/admin*`, `/login`): separate HttpOnly cookie session, OTP + Turnstile, CSRF token plus exact `Origin`/`Sec-Fetch-Site` checks on mutations, audit rows written in the same D1 batch. Admin responses must never expose dictated text, glossary terms, or sync record contents.
- `index.ts` `scheduled` (every 5 min) runs maintenance steps independently; one failing step must not stop the others.

### Clients: parity between Kotlin and TypeScript

The desktop app is **not** built on `shared/`; it re-implements the same logic in TypeScript. When changing sync, auth, or capture behaviour, update both sides:

| Concern | Kotlin (`shared/`) | TypeScript (`desktop/src/`) |
| --- | --- | --- |
| Sync engine | `sync/SyncCoordinator.kt` + `SyncClient.kt` | `main/sync.ts` + `main/worker.ts` |
| Session / token refresh | `account/SessionManager.kt` | `main/session.ts`, `main/auth.ts` |
| Local DB | Room (`data/`, schema exported to `shared/schemas/`) | `main/db.ts` (hand-written migrations in `migrate()`) |
| Legacy vault crypto | `sync/VaultCrypto.kt` | `main/vault-crypto.ts`; vectors from `CrossPlatformVectorTest` are asserted in `test/vault-crypto.test.ts` |
| Silence gate | `voice/SpeechSignalDetector.kt` | `renderer/src/lib/speech.ts` |

Sync semantics both engines follow: pull pages first (server settings applied before any upload), then push local rows in batches of ≤100. Rows carry `syncState` `local` → `queued` → `synced`; a refused batch returns every queued row to `local`. Conflicts resolve server-wins, except a local delete (outbox tombstone) or an undo is re-based onto the server version so it still lands. Desktop syncs history and dictionary only; analytics sync is Android-only.

All local data is partitioned by `ownerAccountId`; signing in to a different account must not mix records (Android prompts about unassigned/legacy data, desktop asks before deleting another account's data).

### Android specifics

- `ime/WoVoiceInputMethodService.kt` owns the `KeyboardState` machine (`VoiceIdle`, `Recording`, `Processing`, `Error`, `ManualKeyboard`). Any path that can leave the keyboard in `Processing`/`Error` with no pending worker must reset to idle (`discardTransientState`).
- `core/EditorPolicy.kt` forces the manual keyboard in password/PIN fields and blocks correction learning in sensitive, email, URL, or no-personalized-learning fields.
- `settings/SetupActivity.kt` is the whole dashboard (Home/History/Dictionary/Settings), built programmatically.
- Secrets use `SecretStore` (Android Keystore AES-GCM); backups are disabled. `AndroidGraph` wires Room (with `MIGRATION_1_2`) and the `SyncCoordinator` singleton.
- Release signing comes from `WOVOICE_KEYSTORE_PATH` / `WOVOICE_STORE_PASSWORD` / `WOVOICE_KEY_ALIAS` / `WOVOICE_KEY_PASSWORD` env vars.

### Desktop specifics

- `main/index.ts` holds IPC handlers (`window.api` via `preload/`), single-instance lock, and `wovoice://` deep links. `main/dictation.ts` is the begin → end → capture → transcribe → paste state machine with a pipeline watchdog; a capture is accepted only while the session is `processing`.
- `main/triggers.ts` spawns `tapd`, which prints `k <keycode> <0|1>` / `m <button> <0|1>` lines; hold-to-talk, quick-tap latch, and middle-click are interpreted in TypeScript. Only Accessibility is required (no Input Monitoring).
- Never log transcript text (stdout is treated as sensitive).
