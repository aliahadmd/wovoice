# AI configuration operations

The admin console exposes `/admin/ai`. Android and Mac use the same published configuration on their next recording; existing client versions need no update.

## Workflow

1. Choose **Speech recognition** for ASR and provider formatting options. Whisper is the economical default; Nova 3 is an alternative. Vocabulary terms remain supplied by the signed-in client.
2. Choose **Text cleanup** for the cleanup switch, approved model, temperature, and response-token ceiling. Keep faithful dictation as the purpose of this stage.
3. Edit **Prompts**. The system prompt defines behavior; the user template supplies sentence context, vocabulary, command instructions, and the transcript. Each required placeholder must appear exactly once. Replacement is single-pass, so placeholders inside dictated text are treated literally.
4. Use **Test workspace** with manually entered sample text. It tests cleanup only, using the currently edited settings. The result shows output checks, a rejected candidate when applicable, rendered model messages, latency, and estimated cost. Changing the sample or settings marks an earlier result stale. No sample, vocabulary, output, or rendered messages are persisted by this endpoint.
5. Enter a change note and **Save draft**. This does not affect recordings. **Review & publish** compares the saved draft with live settings, requires acknowledgment, and creates a published revision.
6. Use **Revisions** to restore a historical revision or deployment defaults as a new draft. Review and publish it to apply the restoration. Concurrent administrators receive a conflict rather than silently overwriting newer work.

**Availability** controls a reversible pause for new dictation, a public maintenance message, and a bounded inference timeout. Authentication and account services remain available while dictation is paused.

## Configuration ownership

Runtime configuration is stored in D1 by migration `0007_ai_configuration.sql`. One singleton points at immutable draft and published revisions. A conditional transactional batch writes the new revision, pointer, and metadata-only audit event together. Each transcription reads one published snapshot and passes it to ASR, cleanup, and quota accounting. Drafts are never read on the inference path. No process-global mutable configuration cache is used.

No published revision means the deployment defaults remain effective, including the existing `ASR_MODEL` value. Publishing does not rewrite environment variables. Failed or missing configuration storage fails closed with a retryable service error.

Approved models and versioned price estimates live in `worker/src/ai-config.ts` and `worker/src/pricing.ts`. Adding a provider/model requires a reviewed code change covering the binding contract, pricing, reservation bounds, and output validation. Arbitrary provider URLs and credentials cannot be entered in the admin UI.

Authentication, CSRF protection, provider training opt-out, output validation, locale, WAV contract, database budget ceilings, and secrets remain deployment-managed. Per-account quota grants remain in Users. These are deliberate boundaries: changing a database-enforced quota requires a migration rather than an editable number that would disagree with its trigger.

Cleanup messages are bounded to 8,192 UTF-8 bytes, with 512 additional tokens reserved for chat-template overhead. Static instructions are limited to half that byte budget. Inputs that exceed the cleanup bound retain ASR text without calling the cleanup model. Output is capped at 1,500 tokens. Reservations use the selected model's rates, including the larger 120B option; known token usage settles actual cost, and attempted previews without usage settle conservatively. Preview requests are separately rate-limited and count against the global neuron ceiling without consuming audio seconds.

Revision history is retained independently of the 90-day operational audit retention, so older configuration revisions remain available for restoration. Avoid putting personal data or credentials in prompts or change notes.

## Release and validation

Run `npm test` and `npm run build` in `worker/`. Tests apply the actual migrations to local D1 and inject fake inference, email, and Turnstile services. Browser review can use isolated fixtures; it must not bypass production admin authentication.

When deployment is authorized, apply the D1 migrations before deploying the Worker. Migration 0007 is additive; an older Worker ignores its tables, and the new Worker starts with existing defaults until the first publication. Deploying the feature must not itself publish an experimental configuration.

Current validation: 76 Worker tests and 6 browser-component tests pass, along with production asset generation and both TypeScript checks. Desktop and phone-sized local browser review covers draft saving, publication review, publication, and the sample test panel. Live inference quality still depends on provider behavior and should be evaluated through authenticated prompt tests before changing the production defaults.

## Primary references

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Whisper Large v3 Turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [GPT OSS 20B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [GPT OSS 120B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

Pricing estimates were checked on November 2, 2026. The platform pricing table is the estimate source of truth; prices are not configurable in the console and are not invoices.
