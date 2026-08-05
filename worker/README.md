# WoVoice transcription Worker

This Worker is the public account, encrypted-sync, and inference boundary for WoVoice.
It serves the website and passwordless authentication flow, stores account/quota data
and opaque encrypted sync records in D1, sends verification and moderation messages
through Cloudflare Email Service, validates Turnstile, and sends temporary WAV audio
to Workers AI. It also serves an Access-protected operational admin console. It
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
3. Create a Cloudflare Access self-hosted application for `/admin` and `/admin/*`, allow only `aliahadmd1@gmail.com`, and use a 30-minute session. Set `ACCESS_TEAM_DOMAIN` to the HTTPS team domain and `ACCESS_AUD` to the application audience tag.
4. Temporarily set `ADMIN_BOOTSTRAP_EMAIL=aliahadmd1@gmail.com` as a Worker secret. The owner must complete the ordinary WoVoice email flow once before D1 grants the admin role.
5. Deploy staging with `npx wrangler deploy --env staging`.
6. Validate email delivery, PKCE exchange, refresh rotation, exact quotas, encrypted sync, Access rejection, moderation, and the audit trail before production.
7. Remove `ADMIN_BOOTSTRAP_EMAIL` immediately after `/admin/api/v1/session` confirms the owner’s D1 role.

For production:

1. Apply the production D1 migrations and configure separate production secrets.
2. Validate with `npx wrangler deploy --dry-run`.
3. Deploy with `npx wrangler deploy --env=""` and attach `wovoice.aliahad.com` as the Custom Domain.
4. Test `/v1/status`, passwordless sign-in, quotas, sync, and Access-protected admin routes before distributing an APK.

The Worker intentionally rejects every `/admin*` request unless both controls pass:

- Cloudflare Access supplies a valid JWT for the configured issuer and audience.
- The encrypted-email lookup resolves to an active D1 user with `role=admin`.

Admin responses contain operational metadata only. They never return audio, dictated
text, glossary entries, recovery material, or encrypted sync ciphertext. Account
status changes, session revocation, and audit insertion use a transactional D1 batch.

Current public status: [wovoice.aliahad.com/status](https://wovoice.aliahad.com/status). The status and authentication configuration endpoints are public; account, sync, and transcription endpoints require a short-lived user access token.

`CLIENT_TOKEN` exists only during the seven-day v1.2 migration window on the old
`workers.dev` hostname. It must be removed after the deadline; the production Custom
Domain never accepts that shared credential.

To benchmark Nova-3, deploy a staging environment with `ASR_MODEL` set to `nova-3`.
Keep the production selection pinned to the result of the personal 30-recording
benchmark.
