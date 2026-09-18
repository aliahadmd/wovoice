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
// Flat polish reservation added to every quota reservation, independent of text length.
export const POLISH_RESERVE_NEURONS = 5;
