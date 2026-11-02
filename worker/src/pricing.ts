import { CLEANUP_CHAT_OVERHEAD_TOKENS, CLEANUP_INPUT_BYTE_LIMIT, cleanupPricing } from "./ai-config";

// Versioned Cloudflare Workers AI pricing for the WoVoice usage estimate.
// handler.ts uses every constant here for response estimates; quota.ts uses the
// ASR neuron rates for reservations. Change them together and bump PRICING_VERSION.
export const PRICING_VERSION = "2026-11-02";
export const WHISPER_NEURONS_PER_MINUTE = 46.63;
export const WHISPER_USD_PER_MINUTE = 0.0005;
export const NOVA_NEURONS_PER_MINUTE = 472.73;
export const NOVA_USD_PER_MINUTE = 0.0052;
const defaultCleanup = cleanupPricing("gpt-oss-20b");
export const POLISH_INPUT_NEURONS_PER_MILLION = defaultCleanup.inputNeuronsPerMillion;
export const POLISH_OUTPUT_NEURONS_PER_MILLION = defaultCleanup.outputNeuronsPerMillion;
export const POLISH_INPUT_USD_PER_MILLION = defaultCleanup.inputUsdPerMillion;
export const POLISH_OUTPUT_USD_PER_MILLION = defaultCleanup.outputUsdPerMillion;
// Polish reservation added to every quota reservation. Completion records
// min(actual, reserved), so the reserve must bound a whole cleanup call: the old
// flat 5 neurons under-counted every glossary-heavy (up to 4,000 glossary chars)
// or reasoning-heavy call against the global daily budget. Rendered UTF-8 input
// is bounded before calling the model; oversized cleanup falls back to ASR.
// The rendered prompt is bounded to 8,192 UTF-8 bytes, plus conservative chat-template overhead.
// Byte-level tokenizers cannot create more text tokens than input bytes.
export const POLISH_MAX_INPUT_TOKENS = CLEANUP_INPUT_BYTE_LIMIT + CLEANUP_CHAT_OVERHEAD_TOKENS;
export const POLISH_MAX_OUTPUT_TOKENS = 1_500;
export const POLISH_RESERVE_NEURONS = Math.ceil(
  (POLISH_MAX_INPUT_TOKENS * POLISH_INPUT_NEURONS_PER_MILLION
    + POLISH_MAX_OUTPUT_TOKENS * POLISH_OUTPUT_NEURONS_PER_MILLION) / 1_000_000,
);
