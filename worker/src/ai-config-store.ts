import { AiConfigValidationError, changedConfigFields, defaultAiConfiguration, validateAiConfiguration, type AiConfiguration, type AiRevision } from "./ai-config";
import { ApiError } from "./errors";
import type { AppEnv } from "./types";

export interface AiConfigState { version: number; active_revision_id: string | null; draft_revision_id: string | null }
interface RevisionRow { id: string; version: number; kind: "draft" | "published"; config_json: string; source_revision_id: string | null; created_by: string | null; reason: string; created_at: number }

function parseConfig(json: string): AiConfiguration {
  try { return validateAiConfiguration(JSON.parse(json)); }
  catch { throw new ApiError(503, "AI_CONFIG_UNAVAILABLE", true, "The AI configuration is unavailable. Please try again shortly."); }
}
function revision(row: RevisionRow): AiRevision {
  return { id: row.id, version: row.version, kind: row.kind, config: parseConfig(row.config_json), sourceRevisionId: row.source_revision_id, createdBy: row.created_by, reason: row.reason, createdAt: row.created_at };
}

export async function readAiRevision(env: AppEnv, id: string): Promise<AiRevision> {
  const row = await env.DB.prepare("SELECT * FROM ai_config_revisions WHERE id = ?").bind(id).first<RevisionRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", false, "This configuration revision does not exist.");
  return revision(row);
}

export async function readAiWorkspace(env: AppEnv) {
  const state = await env.DB.prepare("SELECT version, active_revision_id, draft_revision_id FROM ai_config_state WHERE id = 1").first<AiConfigState>();
  if (!state) throw new ApiError(503, "AI_CONFIG_UNAVAILABLE", true, "AI configuration storage is unavailable.");
  const [active, draft] = await Promise.all([
    state.active_revision_id ? readAiRevision(env, state.active_revision_id) : null,
    state.draft_revision_id ? readAiRevision(env, state.draft_revision_id) : null,
  ]);
  return { version: state.version, active, draft, defaults: defaultAiConfiguration(env.ASR_MODEL), effective: active?.config ?? defaultAiConfiguration(env.ASR_MODEL) };
}

/** One immutable snapshot per recording. Drafts are never consulted on the inference path. */
export async function readActiveAiConfiguration(env: AppEnv): Promise<{ config: AiConfiguration; revisionId: string | null }> {
  const row = await env.DB.prepare(`SELECT s.active_revision_id, r.config_json FROM ai_config_state s
    LEFT JOIN ai_config_revisions r ON r.id = s.active_revision_id WHERE s.id = 1`).first<{ active_revision_id: string | null; config_json: string | null }>();
  if (!row || (row.active_revision_id && !row.config_json)) throw new ApiError(503, "AI_CONFIG_UNAVAILABLE", true, "AI configuration is unavailable.");
  return { config: row.config_json ? parseConfig(row.config_json) : defaultAiConfiguration(env.ASR_MODEL), revisionId: row.active_revision_id };
}

export async function listAiRevisions(env: AppEnv, before?: number) {
  const rows = await env.DB.prepare("SELECT * FROM ai_config_revisions WHERE version < ? ORDER BY version DESC LIMIT 21")
    .bind(before ?? Number.MAX_SAFE_INTEGER).all<RevisionRow>();
  return {
    revisions: rows.results.slice(0, 20).map((row) => {
      const { config, ...metadata } = revision(row);
      return { ...metadata, asrModel: config.asr.model, cleanupModel: config.cleanup.model, cleanupEnabled: config.cleanup.enabled, serviceEnabled: config.service.enabled };
    }),
    nextCursor: rows.results.length > 20 ? rows.results[19].version : null,
  };
}

export function parseConfiguration(value: unknown): AiConfiguration {
  try { return validateAiConfiguration(value); }
  catch (error) {
    if (error instanceof AiConfigValidationError) throw new ApiError(400, "INVALID_REQUEST", false, error.message);
    throw error;
  }
}

export async function saveAiRevision(env: AppEnv, input: {
  actorId: string; requestId: string; expectedVersion: number; config: AiConfiguration;
  reason: string; kind: "draft" | "published"; sourceRevisionId?: string | null;
}): Promise<void> {
  const current = await readAiWorkspace(env);
  if (current.version !== input.expectedVersion || (input.kind === "published" && current.draft?.id !== input.sourceRevisionId)) throw conflict();
  const id = crypto.randomUUID();
  const version = input.expectedVersion + 1;
  const now = Date.now();
  const sourceId = input.sourceRevisionId ?? null;
  const metadata = { revisionId: id, version, asrModel: input.config.asr.model, cleanupModel: input.config.cleanup.model, changedFields: changedConfigFields(current.effective, input.config) };
  // Every write, including its audit event, is conditional on the same version inside a D1 transaction.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_config_revisions
      (id, version, kind, config_json, source_revision_id, created_by, reason, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM ai_config_state WHERE id = 1 AND version = ?
      AND (? != 'published' OR draft_revision_id = ?)`)
      .bind(id, version, input.kind, JSON.stringify(input.config), sourceId, input.actorId, input.reason, now, input.expectedVersion, input.kind, sourceId),
    input.kind === "published"
      ? env.DB.prepare(`UPDATE ai_config_state SET active_revision_id = ?, draft_revision_id = NULL, version = ?
          WHERE id = 1 AND version = ? AND draft_revision_id = ? AND EXISTS(SELECT 1 FROM ai_config_revisions WHERE id = ?)`)
        .bind(id, version, input.expectedVersion, sourceId, id)
      : env.DB.prepare(`UPDATE ai_config_state SET draft_revision_id = ?, version = ? WHERE id = 1 AND version = ?
          AND EXISTS(SELECT 1 FROM ai_config_revisions WHERE id = ?)`)
        .bind(id, version, input.expectedVersion, id),
    env.DB.prepare(`INSERT INTO admin_audit_events
      (id, actor_user_id, target_user_id, action, internal_reason, before_state, after_state, request_id, created_at)
      SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM ai_config_revisions WHERE id = ?)`)
      .bind(crypto.randomUUID(), input.actorId, input.kind === "published" ? "ai_configuration_published" : "ai_configuration_draft_saved", input.reason,
        JSON.stringify({ activeRevisionId: current.active?.id ?? null, draftRevisionId: current.draft?.id ?? null }), JSON.stringify(metadata), input.requestId, now, id),
  ]);
  if (result[1].meta.changes !== 1) throw conflict();
}

function conflict(): ApiError {
  return new ApiError(409, "AI_CONFIG_CONFLICT", false, "Another administrator changed this configuration. Reload the latest version before saving.");
}
