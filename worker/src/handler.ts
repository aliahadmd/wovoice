import { ApiError, errorResponse } from "./errors";
import { authenticateAccess, handleAccountRoute, handleAuthRoute, productionAuthServices } from "./auth";
import { productionServices } from "./models";
import { parseOptions } from "./options";
import { completeQuota, releaseQuota, reserveQuota, type QuotaReservation } from "./quota";
import { handleSyncRoute } from "./sync";
import type { AppEnv, AuthServices, Principal, Services } from "./types";
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
const RELEASE_CERT_SHA256 =
  "3A:E4:93:35:28:83:E2:7F:98:ED:93:60:A4:C2:95:6B:66:2C:24:1C:74:FC:2B:B8:5C:5A:C1:6F:3F:2F:D1:D4";
const DEBUG_CERT_SHA256 =
  "EC:F2:BE:43:B8:6F:94:29:CF:7F:21:2D:90:F6:7D:AC:04:A7:31:20:7A:BA:58:11:C4:82:B3:13:36:11:67:19";

export function createHandler(
  services: Services = productionServices,
  authServices: AuthServices = productionAuthServices,
) {
  return async (request: Request, env: AppEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/assetlinks.json") {
      return Response.json(androidAssetLinks(env), {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/status")) {
      return Response.json({
        name: "WoVoice API",
        status: "online",
        apiVersion: "v1",
        documentation: "https://github.com/aliahadmd/wovoice",
        authentication: "Passwordless WoVoice account required for protected endpoints",
      });
    }

    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    let audioBytes = 0;
    let selectedModel: "nova-3" | "whisper-large-v3-turbo" =
      env.ASR_MODEL === "nova-3" ? "nova-3" : "whisper-large-v3-turbo";
    let status = 500;
    let asrMs = 0;
    let polishMs = 0;
    let totalNeurons: number | null = null;
    let principal: Principal | null = null;
    let reservation: QuotaReservation | null = null;
    let quotaCompleted = false;

    try {
      const authResponse = await handleAuthRoute(request, env, authServices, requestId);
      if (authResponse) {
        status = authResponse.status;
        return authResponse;
      }
      const accountResponse = await handleAccountRoute(request, env, requestId);
      if (accountResponse) {
        status = accountResponse.status;
        return accountResponse;
      }
      const syncResponse = await handleSyncRoute(request, env, requestId);
      if (syncResponse) {
        status = syncResponse.status;
        return syncResponse;
      }

      principal = await authenticatePrincipal(request, env, url);
      const rate = await env.RATE_LIMITER.limit({ key: principal.userId });
      if (!rate.success) {
        throw new ApiError(429, "RATE_LIMITED", true, "Too many recordings. Please wait a moment.", 60);
      }

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
      if (!principal.legacy) {
        reservation = await reserveQuota(env, principal.userId, requestId, wav.durationSeconds);
      }

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
        if (reservation) {
          await completeQuota(env, reservation, totalNeurons ?? reservation.reservedNeurons);
          quotaCompleted = true;
        }
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
      if (reservation && !quotaCompleted) {
        try {
          await releaseQuota(env, reservation);
        } catch {
          // The scheduled cleanup releases any reservation left by an interrupted request.
        }
      }
      console.log(
        JSON.stringify({
          event: "api_request",
          requestId,
          route: url.pathname,
          subjectId: principal?.userId ?? null,
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

function androidAssetLinks(env: AppEnv): unknown[] {
  const staging = env.ENVIRONMENT === "staging";
  const fingerprint = staging ? DEBUG_CERT_SHA256 : RELEASE_CERT_SHA256;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: staging ? "com.aliahad.wovoice.staging" : "com.aliahad.wovoice",
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ];
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

async function authenticatePrincipal(request: Request, env: AppEnv, url: URL): Promise<Principal> {
  if (await acceptsLegacyToken(request, env, url)) {
    return { userId: "legacy", sessionId: "legacy", legacy: true };
  }
  return authenticateAccess(request, env);
}

async function acceptsLegacyToken(request: Request, env: AppEnv, url: URL): Promise<boolean> {
  if (url.hostname !== "wovoice-transcription.aliahad.workers.dev") return false;
  const deadline = Date.parse(env.LEGACY_AUTH_DEADLINE);
  if (!Number.isFinite(deadline) || Date.now() >= deadline || !env.CLIENT_TOKEN) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CLIENT_TOKEN)),
  ]);
  return Boolean(token && crypto.subtle.timingSafeEqual(actualHash, expectedHash));
}
