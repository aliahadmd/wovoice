# WoVoice transcription Worker

This Worker is the public account, cloud-sync, and inference boundary for WoVoice.
It serves the website and passwordless authentication flow, stores account/quota data
and cloud-sync records (encrypted by the Worker) in D1, sends verification and moderation messages
through Cloudflare Email Service, validates Turnstile, and sends temporary WAV audio
to Workers AI. It also serves a first-party, email-verified operational admin console. It
does not configure KV, R2, transcript storage, or AI Gateway prompt logging.

Successful transcription responses also include an optional `usage` object. It is
calculated from the validated audio duration and model-reported cleanup token counts,
uses a versioned Cloudflare pricing table, and is always marked as an estimate. If
token usage is unavailable, `usage` is `null` instead of returning invented precision.

## Local verification

```sh
npm install
cp .dev.vars.example .dev.vars
npm run types
npm test
npm run build
```

## Deployment

1. Configure Email Service for `login@wovoice.aliahad.com`, the production Turnstile widget, and the required secrets (`AUTH_MASTER_KEY`, `PII_KEY`, `TURNSTILE_SECRET`, and `SYNC_KEK`). Generate `SYNC_KEK` once with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` and store it with `npx wrangler secret put SYNC_KEK`; losing it makes every synced record unreadable.
2. Apply production migrations with `npx wrangler d1 migrations apply wovoice-accounts-production --remote`.
3. Build and validate with `npm test`, `npm run build`, and `npx wrangler deploy --dry-run`.
4. Deploy with `npx wrangler deploy` and keep `wovoice.aliahad.com` attached as the Custom Domain.
5. Test `/v1/status`, Android passwordless sign-in, `/login`, quotas, cloud sync, moderation, and the audit trail before distributing an APK.

The Worker intentionally rejects every `/admin*` request unless a short-lived,
HttpOnly browser session resolves to an active D1 user with `role=admin`. Login uses
email OTP plus Turnstile, and state-changing requests require a session-bound CSRF
token and exact same-origin browser headers.

Admin responses contain operational metadata only. They never return audio, dictated
text, glossary entries, or synced record contents. Account
status changes, session revocation, and audit insertion use a transactional D1 batch.

Current public status: [wovoice.aliahad.com/status](https://wovoice.aliahad.com/status). The status and authentication configuration endpoints are public; account, sync, and transcription endpoints require a short-lived user access token. The v1.2 shared-token legacy credential was a seven-day migration bridge only; that path has been removed and every protected endpoint now requires a per-user session, on the Custom Domain and `workers.dev` alike.

Keep the production ASR selection pinned to the result of the personal 30-recording benchmark.

## Cloud sync

Devices sync history, dictionary entries, and analytics through `/v2/sync` with only
their sign-in session. Records arrive as plain JSON over TLS; before a record reaches
D1 the Worker seals it with AES-GCM under the account's own data key, bound to the
account, record type, and record id. Each data key is stored wrapped by `SYNC_KEK`
(envelope encryption), so a D1 export, backup, or console session holds only
ciphertext. The WoVoice service can decrypt records to deliver them; the admin
console only ever shows record counts and sizes.

- `GET /v2/sync?cursor=` pages the change feed (one row per record at its latest write)
  and returns the account's sync settings on the first and last page.
- `POST /v2/sync/batch` uploads up to 100 records with optimistic versions; conflicts
  return the server copy.
- `GET`/`PUT /v2/sync/settings` hold `historySyncEnabled` (turning it off deletes the
  account's cloud history) and `historyRetentionDays` (30, 90, 365, or null).
- Accounts keep at most 10,000 history and 20,000 analytics records (oldest deleted
  first) and 1,000 dictionary terms (further terms are refused).
- The scheduled job deletes history older than each account's retention everywhere.

**Rotating `SYNC_KEK`:** set the old key as `SYNC_KEK_PREVIOUS`, the new key as
`SYNC_KEK`, and bump the `SYNC_KEK_VERSION` var. Each account's data key is re-wrapped
the next time it is used; remove `SYNC_KEK_PREVIOUS` once every account has been read.

**Retiring v1 (recovery-key vault):** a device that still holds an account's vault key
imports the vault once and calls `POST /v2/sync/migration`; v1 routes then answer
`426 UPGRADE_REQUIRED` for that account and its v1 ciphertext is purged after 30 days.
Set the `SYNC_V1_SUNSET_AT` var (an ISO date) to close v1 for every account; the
scheduled job then purges all remaining vaults. After the sunset, a later migration can
drop `sync_items`, `sync_changes`, and the users' vault columns.
