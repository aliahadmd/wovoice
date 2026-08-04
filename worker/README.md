# WoVoice transcription Worker

This Worker is the public account, encrypted-sync, and inference boundary for WoVoice.
It serves the website and passwordless authentication flow, stores account/quota data
and opaque encrypted sync records in D1, sends verification codes through Cloudflare
Email Service, validates Turnstile, and sends temporary WAV audio to Workers AI. It
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
npm run check
```

## Deployment

1. Create the staging D1 database and apply `npx wrangler d1 migrations apply wovoice-accounts-staging --env staging --remote`.
2. Configure Email Service for `login@wovoice.aliahad.com`, a staging Turnstile widget, and the required secrets (`AUTH_MASTER_KEY`, `PII_KEY`, and `TURNSTILE_SECRET`).
3. Deploy staging with `npx wrangler deploy --env staging`.
4. Validate email delivery, PKCE exchange, refresh rotation, exact quotas, and encrypted sync before production.

For production:

1. Apply the production D1 migrations and configure separate production secrets.
2. Validate with `npx wrangler deploy --dry-run`.
3. Deploy with `npx wrangler deploy --env=""` and attach `wovoice.aliahad.com` as the Custom Domain.
4. Test `/v1/status`, passwordless sign-in, quotas, and sync before distributing an APK.

Current public status: [wovoice.aliahad.com/status](https://wovoice.aliahad.com/status). The status and authentication configuration endpoints are public; account, sync, and transcription endpoints require a short-lived user access token.

`CLIENT_TOKEN` exists only during the seven-day v1.2 migration window on the old
`workers.dev` hostname. It must be removed after the deadline; the production Custom
Domain never accepts that shared credential.

To benchmark Nova-3, deploy a staging environment with `ASR_MODEL` set to `nova-3`.
Keep the production selection pinned to the result of the personal 30-recording
benchmark.
