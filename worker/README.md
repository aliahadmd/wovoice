# WoVoice transcription Worker

This Worker is the public account, encrypted-sync, and inference boundary for WoVoice.
It serves the website and passwordless authentication flow, stores account/quota data
and opaque encrypted sync records in D1, sends verification and moderation messages
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

1. Configure Email Service for `login@wovoice.aliahad.com`, the production Turnstile widget, and the required secrets (`AUTH_MASTER_KEY`, `PII_KEY`, and `TURNSTILE_SECRET`).
2. Apply production migrations with `npx wrangler d1 migrations apply wovoice-accounts-production --remote`.
3. Build and validate with `npm test`, `npm run build`, and `npx wrangler deploy --dry-run`.
4. Deploy with `npx wrangler deploy` and keep `wovoice.aliahad.com` attached as the Custom Domain.
5. Test `/v1/status`, Android passwordless sign-in, `/login`, quotas, encrypted sync, moderation, and the audit trail before distributing an APK.

The Worker intentionally rejects every `/admin*` request unless a short-lived,
HttpOnly browser session resolves to an active D1 user with `role=admin`. Login uses
email OTP plus Turnstile, and state-changing requests require a session-bound CSRF
token and exact same-origin browser headers.

Admin responses contain operational metadata only. They never return audio, dictated
text, glossary entries, recovery material, or encrypted sync ciphertext. Account
status changes, session revocation, and audit insertion use a transactional D1 batch.

Current public status: [wovoice.aliahad.com/status](https://wovoice.aliahad.com/status). The status and authentication configuration endpoints are public; account, sync, and transcription endpoints require a short-lived user access token.

`CLIENT_TOKEN` exists only during the seven-day v1.2 migration window on the old
`workers.dev` hostname. It must be removed after the deadline; the production Custom
Domain never accepts that shared credential.

Keep the production ASR selection pinned to the result of the personal 30-recording benchmark.
