import { AI_MODEL_CATALOG, CLEANUP_INPUT_BYTE_LIMIT, assertPolishInputFits, cleanupPricing, cleanupReservation, isRecord, polishMessages } from "./ai-config";
import { listAiRevisions, parseConfiguration, readAiRevision, readAiWorkspace, saveAiRevision } from "./ai-config-store";
import { ApiError } from "./errors";
import { noStoreJson, readJson } from "./http";
import { BASE_DAILY_AUDIO_SECONDS, GLOBAL_DAILY_NEURON_LIMIT, MONTHLY_EMAIL_LIMIT } from "./limits";
import { completeQuota, releaseQuota, reserveQuota } from "./quota";
import type { AppEnv, Services, TranscriptionOptions } from "./types";
import { chooseSafePolish } from "./validation";

export async function handleAdminAiRoute(request: Request, env: AppEnv, requestId: string, actorId: string, services: Services): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/admin/api/v1".length);
  if (!path.startsWith("/ai/")) return null;
  if (request.method === "GET" && path === "/ai/config") return workspace(env, requestId);
  if (request.method === "GET" && path === "/ai/revisions") {
    const raw = url.searchParams.get("before");
    const before = raw === null ? undefined : integer(Number(raw), "Revision cursor", 1);
    return noStoreJson({ requestId, ...await listAiRevisions(env, before) });
  }
  if (request.method === "POST" && ["/ai/config/draft", "/ai/config/publish", "/ai/config/restore"].includes(path)) {
    const body = await bodyObject(request);
    const expectedVersion = integer(body.expectedVersion, "Configuration version", 0);
    const reason = boundedText(body.reason, "Change reason", 5, 500);
    if (path === "/ai/config/draft") {
      await saveAiRevision(env, { actorId, requestId, expectedVersion, reason, kind: "draft", config: parseConfiguration(body.config) });
    } else {
      const source = path.endsWith("restore") && body.revisionId === "defaults" ? null
        : await readAiRevision(env, boundedText(body.revisionId, "Revision", 1, 100));
      const current = await readAiWorkspace(env);
      if (path.endsWith("publish") && (!source || current.draft?.id !== source.id || current.version !== expectedVersion)) {
        throw new ApiError(409, "AI_CONFIG_CONFLICT", false, "The draft changed. Reload before publishing.");
      }
      await saveAiRevision(env, { actorId, requestId, expectedVersion, reason, kind: path.endsWith("publish") ? "published" : "draft", config: source?.config ?? current.defaults, sourceRevisionId: source?.id });
    }
    return workspace(env, requestId);
  }
  if (request.method === "POST" && path === "/ai/preview") {
    const rate = await env.AUTH_RATE_LIMITER.limit({ key: `admin-ai-preview:${actorId}` });
    if (!rate.success) throw new ApiError(429, "RATE_LIMITED", true, "Too many test runs. Wait a minute before testing again.", 60);
    const body = await bodyObject(request);
    const config = parseConfiguration(body.config);
    const text = boundedText(body.text, "Sample transcript", 1, 4_000);
    const glossary = body.glossary;
    if (!Array.isArray(glossary) || glossary.length > 30 || !glossary.every((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 80)
      || typeof body.sentenceStart !== "boolean" || typeof body.commands !== "boolean") throw new ApiError(400, "INVALID_REQUEST", false, "The sample context is invalid.");
    const options: TranscriptionOptions = { locale: "en-IN", polish: "light", sentenceStart: body.sentenceStart, commands: body.commands ? ["new_line", "new_paragraph"] : [], glossary };
    try { assertPolishInputFits(config, text, options); }
    catch { throw new ApiError(400, "INVALID_REQUEST", false, "The combined prompt and sample exceed the cleanup input budget. Shorten the prompt or sample."); }
    const messages = polishMessages(config, text, options);
    if (!config.cleanup.enabled) return noStoreJson({ requestId, text, candidate: null, accepted: false, status: "cleanup_disabled", messages, latencyMs: 0, usage: null });
    const reservation = await reserveQuota(env, actorId, requestId, 0, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.service.timeoutMs);
    const startedAt = performance.now();
    let settled = false;
    try {
      const result = await services.polish(env, text, options, controller.signal, config);
      const safe = chooseSafePolish(text, result.text);
      const price = cleanupPricing(config.cleanup.model);
      const usage = result.inputTokens !== null && result.outputTokens !== null ? {
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        neurons: (result.inputTokens * price.inputNeuronsPerMillion + result.outputTokens * price.outputNeuronsPerMillion) / 1_000_000,
        estimatedCostUsd: (result.inputTokens * price.inputUsdPerMillion + result.outputTokens * price.outputUsdPerMillion) / 1_000_000,
      } : null;
      await completeQuota(env, reservation, usage?.neurons ?? reservation.reservedNeurons);
      settled = true;
      // Neither the sample, model output, nor rendered prompts are persisted in audit or user History.
      return noStoreJson({ requestId, text: safe ?? text, candidate: result.text, accepted: safe !== null,
        status: safe === null ? "guardrail_fallback" : "accepted", messages, model: config.cleanup.model, latencyMs: Math.round(performance.now() - startedAt), usage });
    } catch {
      // An attempted inference may be billed even if it times out. Settle its conservative reserve.
      await completeQuota(env, reservation, reservation.reservedNeurons); settled = true;
      throw new ApiError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "INFERENCE_TIMEOUT" : "INFERENCE_FAILED", true, "The cleanup test could not finish. No configuration was changed.");
    } finally {
      clearTimeout(timer);
      if (!settled) await releaseQuota(env, reservation);
    }
  }
  throw new ApiError(404, "NOT_FOUND", false, "This AI administration endpoint does not exist.");
}

async function workspace(env: AppEnv, requestId: string): Promise<Response> {
  const state = await readAiWorkspace(env);
  return noStoreJson({ requestId, ...state, catalog: AI_MODEL_CATALOG,
    safeguards: { locale: "en-IN", maxAudioSeconds: 60, maxCleanupInputBytes: CLEANUP_INPUT_BYTE_LIMIT, outputValidation: true, providerTrainingOptOut: true,
      baseDailyAudioSeconds: BASE_DAILY_AUDIO_SECONDS, globalDailyNeurons: GLOBAL_DAILY_NEURON_LIMIT, monthlyEmails: MONTHLY_EMAIL_LIMIT,
      cleanupReservedNeurons: cleanupReservation(state.draft?.config ?? state.effective) } });
}
async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson<unknown>(request);
  if (!isRecord(value)) throw new ApiError(400, "INVALID_REQUEST", false, "A configuration request is required.");
  return value;
}
function boundedText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max || value.includes("\0")) throw new ApiError(400, "INVALID_REQUEST", false, `${name} must contain ${min}–${max} characters.`);
  return value.trim();
}
function integer(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new ApiError(400, "INVALID_REQUEST", false, `${name} is invalid.`);
  return value;
}
