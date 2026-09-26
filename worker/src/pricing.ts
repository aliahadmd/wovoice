// Versioned Cloudflare Workers AI pricing for the WoVoice usage estimate.
// handler.ts uses every constant here for response estimates; quota.ts uses the
// ASR neuron rates for reservations. Change them together and bump PRICING_VERSION.
export const PRICING_VERSION = "2026-07-08";
export const WHISPER_NEURONS_PER_MINUTE = 46.63;
export const WHISPER_USD_PER_MINUTE = 0.0005;
export const NOVA_NEURONS_PER_MINUTE = 472.73;
export const NOVA_USD_PER_MINUTE = 0.0052;
export const POLISH_INPUT_NEURONS_PER_MILLION = 18_182;
export const POLISH_OUTPUT_NEURONS_PER_MILLION = 27_273;
export const POLISH_INPUT_USD_PER_MILLION = 0.2;
export const POLISH_OUTPUT_USD_PER_MILLION = 0.3;
// Polish reservation added to every quota reservation. Completion records
// min(actual, reserved), so the reserve must bound a whole cleanup call: the old
// flat 5 neurons under-counted every glossary-heavy (up to 4,000 glossary chars)
// or reasoning-heavy call against the global daily budget. Input stays under
// ~2,000 tokens (prompt + glossary + 60 s of speech); output is capped by the
// 1,500-token max_tokens ceiling in models.ts.
export const POLISH_MAX_INPUT_TOKENS = 2_000;
export const POLISH_MAX_OUTPUT_TOKENS = 1_500;
export const POLISH_RESERVE_NEURONS = Math.ceil(
  (POLISH_MAX_INPUT_TOKENS * POLISH_INPUT_NEURONS_PER_MILLION
    + POLISH_MAX_OUTPUT_TOKENS * POLISH_OUTPUT_NEURONS_PER_MILLION) / 1_000_000,
);
