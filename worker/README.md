# WoVoice transcription Worker

This Worker is the private network boundary for WoVoice. The Android app sends one
temporary WAV recording, and the Worker returns a transcript. It does not configure
KV, D1, R2, transcript storage, or AI Gateway logging.

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

1. Create the included staging Worker first and keep `ASR_MODEL` set to `whisper`.
2. Generate a long random device token and add it without writing it to source:
   `npx wrangler secret put CLIENT_TOKEN --env staging`.
3. Deploy staging with `npx wrangler deploy --env staging`.
4. Enter the resulting HTTPS URL and the same device token in WoVoice settings.

To benchmark Nova-3, deploy a staging environment with `ASR_MODEL` set to `nova-3`.
Keep the production selection pinned to the result of the personal 30-recording
benchmark.
