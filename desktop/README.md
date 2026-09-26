# WoVoice for macOS

Hold a key anywhere on your Mac, speak, and release: WoVoice transcribes the
recording with the WoVoice Worker and pastes the text at your cursor. It uses the
same account, daily quota, and encrypted cloud sync as the Android keyboard.

## How it fits together

| Part | Where | Role |
| --- | --- | --- |
| Main process | `src/main/` | Trigger tap, dictation state machine, paste, account session, local database, encrypted sync |
| Trigger helper | `native/tapd.c` | Tiny event-tap daemon that reports the trigger key and middle button to the main process |
| Overlay | `src/renderer/overlay.html`, `src/renderer/src/overlay/` | The recording bubble: captures audio, applies the silence gate, encodes 16 kHz WAV |
| Dashboard | `src/renderer/src/App.tsx` | Home, History, Dictionary, Account, and Settings |
| Preload | `src/preload/` | The IPC bridge the renderer uses (`window.api`) |

- **Session:** the refresh token is sealed with the macOS Keychain (Electron
  `safeStorage`). A refresh token the server rejects signs the app out.
- **Local data:** Node's built-in SQLite at
  `~/Library/Application Support/WoVoice/wovoice-desktop.db`. Signing in to a
  different account asks before removing the previous account's local data.
- **Cloud sync:** `src/main/sync.ts` mirrors the phone's `SyncCoordinator`
  (history and dictionary; analytics stay on the phone). Records sync through
  the account over `/v2/sync`, and the Worker encrypts them with the account's
  key, so signing in is the only setup. The Account tab offers **Sync now**,
  **Sync history**, and **Auto-delete history**. A Mac that still holds an old
  recovery-key vault imports it once, then deletes the key files.

## Permissions

WoVoice needs **Microphone** access and **Accessibility** (System Settings →
Privacy & Security). Accessibility lets the helper watch the trigger key and lets
WoVoice paste. The first paste also asks to control **System Events**, which
sends the ⌘V keystroke. Input Monitoring is not used.

## Development

```bash
npm install
npm run dev          # electron-vite dev server with the dashboard and overlay
npm test             # node:test suites in test/ (database, sync, vault crypto, WAV)
npm run typecheck
npm run lint
```

The trigger helper must be built once before triggers work in development:

```bash
npm run build:native
```

## Building the DMG

```bash
npm run build:mac    # builds native/tapd, bundles, and writes dist/wovoice-desktop-<version>.dmg
```

`electron-builder.yml` signs with the maintainer's Apple Development identity, so
macOS permission grants survive rebuilds. CI builds an unsigned DMG unless the
`WOVOICE_MAC_IDENTITY` secret is set.
