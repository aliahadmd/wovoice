import { ApiError, errorResponse } from "./errors";
import { productionServices } from "./models";
import { parseOptions } from "./options";
import type { AppEnv, Services } from "./types";
import { chooseSafePolish } from "./validation";
import { readBodyLimited, validateWav } from "./wav";

const INFERENCE_TIMEOUT_MS = 25_000;
const PRICING_VERSION = "2026-07-08";
const WHISPER_NEURONS_PER_MINUTE = 46.63;
const WHISPER_USD_PER_MINUTE = 0.0005;
const NOVA_NEURONS_PER_MINUTE = 472.73;
const NOVA_USD_PER_MINUTE = 0.0052;
const POLISH_INPUT_NEURONS_PER_MILLION = 18_182;
const POLISH_OUTPUT_NEURONS_PER_MILLION = 27_273;
const POLISH_INPUT_USD_PER_MILLION = 0.2;
const POLISH_OUTPUT_USD_PER_MILLION = 0.3;

export function createHandler(services: Services = productionServices) {
  return async (request: Request, env: AppEnv): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    let audioBytes = 0;
    let selectedModel: "nova-3" | "whisper-large-v3-turbo" =
      env.ASR_MODEL === "nova-3" ? "nova-3" : "whisper-large-v3-turbo";
    let status = 500;
    let asrMs = 0;
    let polishMs = 0;
    let totalNeurons: number | null = null;

    try {
      const token = await authenticate(request, env.CLIENT_TOKEN);
      const rateKey = await digestHex(token);
      const rate = await env.RATE_LIMITER.limit({ key: rateKey });
      if (!rate.success) {
        throw new ApiError(429, "RATE_LIMITED", true, "Too many recordings. Please wait a moment.");
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        status = 200;
        return Response.json({ requestId, ok: true }, { status });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/transcriptions") {
        throw new ApiError(404, "NOT_FOUND", false, "This endpoint does not exist.");
      }
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        throw new ApiError(400, "INVALID_REQUEST", false, "A multipart recording is required.");
      }

      const body = await readBodyLimited(request);
      const parsedRequest = new Request(request.url, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      const form = await parsedRequest.formData();
      const file = form.get("audio");
      if (!(file instanceof File)) {
        throw new ApiError(400, "INVALID_REQUEST", false, "The audio recording is missing.");
      }
      const options = parseOptions(form.get("options"));
      const audio = await file.arrayBuffer();
      audioBytes = audio.byteLength;
      const wav = validateWav(audio);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("inference timeout"), INFERENCE_TIMEOUT_MS);
      try {
        const asrStartedAt = performance.now();
        const result = await services.transcribe(env, audio, options, controller.signal);
        asrMs = Math.round(performance.now() - asrStartedAt);
        selectedModel = result.model;

        let finalText = result.text.trim();
        let polished = false;
        let polishTokens: { input: number; output: number } | null = null;
        const polishStartedAt = performance.now();
        try {
          const candidate = await services.polish(env, finalText, options, controller.signal);
          if (candidate.inputTokens !== null && candidate.outputTokens !== null) {
            polishTokens = { input: candidate.inputTokens, output: candidate.outputTokens };
          }
          const safe = chooseSafePolish(finalText, candidate.text);
          if (safe !== null) {
            polished = safe !== finalText;
            finalText = safe;
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // A cleanup failure is intentionally non-fatal; the ASR text is safer.
        }
        polishMs = Math.round(performance.now() - polishStartedAt);
        const usage = buildUsage(selectedModel, wav.durationSeconds, polishTokens);
        totalNeurons = usage?.totalNeurons ?? null;
        status = 200;
        return Response.json(
          {
            requestId,
            text: finalText,
            rawText: result.text.trim(),
            polished,
            asrModel: selectedModel,
            timingsMs: {
              asr: asrMs,
              polish: polishMs,
              total: Math.round(performance.now() - startedAt),
            },
            usage,
          },
          { status },
        );
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ApiError(504, "INFERENCE_TIMEOUT", true, "Transcription took too long. Please try again.");
        }
        throw new ApiError(502, "INFERENCE_FAILED", true, "Transcription failed. Please try again.");
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const safeError =
        error instanceof ApiError
          ? error
          : new ApiError(500, "INFERENCE_FAILED", true, "Something went wrong. Please try again.");
      status = safeError.status;
      return errorResponse(safeError, requestId);
    } finally {
      console.log(
        JSON.stringify({
          event: "transcription_request",
          requestId,
          audioBytes,
          asrModel: selectedModel,
          timingsMs: {
            asr: asrMs,
            polish: polishMs,
            total: Math.round(performance.now() - startedAt),
          },
          status,
          totalNeurons,
        }),
      );
    }
  };
}

export interface UsageEstimate {
  estimated: true;
  currency: "USD";
  pricingVersion: string;
  audioSeconds: number;
  inputTokens: number;
  outputTokens: number;
  asrNeurons: number;
  polishNeurons: number;
  totalNeurons: number;
  estimatedCostUsd: number;
}

export function buildUsage(
  model: "whisper-large-v3-turbo" | "nova-3",
  audioSeconds: number,
  polishTokens: { input: number; output: number } | null,
): UsageEstimate | null {
  if (!polishTokens) return null;
  const minutes = audioSeconds / 60;
  const nova = model === "nova-3";
  const asrNeurons = minutes * (nova ? NOVA_NEURONS_PER_MINUTE : WHISPER_NEURONS_PER_MINUTE);
  const asrCost = minutes * (nova ? NOVA_USD_PER_MINUTE : WHISPER_USD_PER_MINUTE);
  const polishNeurons =
    (polishTokens.input * POLISH_INPUT_NEURONS_PER_MILLION +
      polishTokens.output * POLISH_OUTPUT_NEURONS_PER_MILLION) /
    1_000_000;
  const polishCost =
    (polishTokens.input * POLISH_INPUT_USD_PER_MILLION +
      polishTokens.output * POLISH_OUTPUT_USD_PER_MILLION) /
    1_000_000;
  return {
    estimated: true,
    currency: "USD",
    pricingVersion: PRICING_VERSION,
    audioSeconds: round(audioSeconds, 3),
    inputTokens: polishTokens.input,
    outputTokens: polishTokens.output,
    asrNeurons: round(asrNeurons, 3),
    polishNeurons: round(polishNeurons, 3),
    totalNeurons: round(asrNeurons + polishNeurons, 3),
    estimatedCostUsd: round(asrCost + polishCost, 8),
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function authenticate(request: Request, expectedToken: string): Promise<string> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedToken)),
  ]);
  if (!token || !expectedToken || !crypto.subtle.timingSafeEqual(actualHash, expectedHash)) {
    throw new ApiError(401, "AUTHENTICATION_FAILED", false, "The device token is not accepted.");
  }
  return token;
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
