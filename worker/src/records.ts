import { authenticateAccess } from "./auth";
import { fromBase64Url, importAesKey, openBytes, sealBytes } from "./crypto";
import { ApiError, errorResponse } from "./errors";
import { noStoreJson, readJson } from "./http";
import { recordActivity, requireActiveAccount, safeFailure } from "./moderation";
import type { AppEnv, Principal } from "./types";

/**
 * Cloud sync (v2). Devices send and receive plain record payloads over TLS; the
 * Worker seals each record with the account's own data key before it reaches D1.
 * The data key is stored wrapped by the SYNC_KEK Worker secret (envelope
 * encryption), so a D1 export, backup, or console session sees only ciphertext.
 * Signing in is all a device needs — there is no vault or recovery key.
 */

type RecordType = "history" | "dictionary" | "analytics";

const RECORD_TYPES = new Set<RecordType>(["history", "dictionary", "analytics"]);
const MAX_BATCH_ITEMS = 100;
const MAX_PAGE_ITEMS = 100;
const MAX_PAYLOAD_CHARS = 32_768;
const RETENTION_CHOICES = new Set([30, 90, 365]);
const DATA_KEY_VERSION = 1;
const V1_PURGE_GRACE_MS = 30 * 86_400_000;

/** Per-account ceilings. History and analytics keep their newest records; the dictionary refuses more. */
export const RECORD_LIMITS: Record<RecordType, number> = {
  history: 10_000,
  dictionary: 1_000,
  analytics: 20_000,
};

interface RecordWrite {
  id: string;
  type: RecordType;
  baseVersion: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

interface RecordRow {
  item_id: string;
  item_type: RecordType;
  version: number;
  key_version: number | null;
  nonce: string | null;
  ciphertext: string | null;
  deleted: number;
  modified_at: number;
}

interface SyncSettings {
  historySyncEnabled: boolean;
  historyRetentionDays: number | null;
}

export async function handleRecordsRoute(request: Request, env: AppEnv, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v2/sync" && !url.pathname.startsWith("/v2/sync/")) return null;
  const principal = await requireActiveAccount(env, await authenticateAccess(request, env));
  const rate = await env.USER_API_RATE_LIMITER.limit({ key: principal.userId });
  if (!rate.success) {
    throw new ApiError(429, "RATE_LIMITED", true, "Too many sync requests. Please wait a moment.", 60);
  }

  if (request.method === "GET" && url.pathname === "/v2/sync/settings") {
    return noStoreJson({ requestId, settings: await readSettings(env, principal.userId) });
  }
  if (request.method === "PUT" && url.pathname === "/v2/sync/settings") {
    return updateSettings(request, env, requestId, principal);
  }
  if (request.method === "POST" && url.pathname === "/v2/sync/migration") {
    // A device that held the v1 vault key has re-uploaded its contents: v1 sync
    // closes for this account and its v1 ciphertext is purged after a grace period.
    await env.DB.prepare(
      "UPDATE users SET sync_v1_migrated_at = COALESCE(sync_v1_migrated_at, ?) WHERE id = ?",
    ).bind(Date.now(), principal.userId).run();
    return noStoreJson({ requestId, migrated: true });
  }
  if (request.method === "GET" && url.pathname === "/v2/sync") {
    return pull(env, requestId, principal, url);
  }
  if (request.method === "POST" && url.pathname === "/v2/sync/batch") {
    return push(request, env, requestId, principal);
  }
  return null;
}

async function readSettings(env: AppEnv, userId: string): Promise<SyncSettings & {
  limits: Record<RecordType, number>;
  legacyVault: boolean;
}> {
  const row = await env.DB.prepare(
    `SELECT history_sync_enabled, history_retention_days, wrapped_vault_key, sync_v1_migrated_at
     FROM users WHERE id = ?`,
  ).bind(userId).first<{
    history_sync_enabled: number;
    history_retention_days: number | null;
    wrapped_vault_key: string | null;
    sync_v1_migrated_at: number | null;
  }>();
  if (!row) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  return {
    historySyncEnabled: row.history_sync_enabled === 1,
    historyRetentionDays: row.history_retention_days,
    limits: RECORD_LIMITS,
    // Tells a device holding the old vault key that its v1 records still need importing.
    legacyVault: row.wrapped_vault_key !== null && row.sync_v1_migrated_at === null && !v1Sunset(env),
  };
}

async function updateSettings(request: Request, env: AppEnv, requestId: string, principal: Principal): Promise<Response> {
  const body = await readJson<{ historySyncEnabled?: unknown; historyRetentionDays?: unknown }>(request);
  const current = await readSettings(env, principal.userId);
  let historySyncEnabled = current.historySyncEnabled;
  let historyRetentionDays = current.historyRetentionDays;
  if (body.historySyncEnabled !== undefined) {
    if (typeof body.historySyncEnabled !== "boolean") invalidSettings();
    historySyncEnabled = body.historySyncEnabled;
  }
  if (body.historyRetentionDays !== undefined) {
    if (body.historyRetentionDays !== null
      && !(typeof body.historyRetentionDays === "number" && RETENTION_CHOICES.has(body.historyRetentionDays))) {
      invalidSettings();
    }
    historyRetentionDays = body.historyRetentionDays as number | null;
  }
  const statements = [
    env.DB.prepare("UPDATE users SET history_sync_enabled = ?, history_retention_days = ? WHERE id = ?")
      .bind(historySyncEnabled ? 1 : 0, historyRetentionDays, principal.userId),
  ];
  if (current.historySyncEnabled && !historySyncEnabled) {
    // Turning history sync off removes the account's cloud copy outright. No
    // tombstones: every device keeps its local history.
    statements.push(
      env.DB.prepare("DELETE FROM sync_record_changes WHERE user_id = ? AND item_type = 'history'")
        .bind(principal.userId),
      env.DB.prepare("DELETE FROM sync_records WHERE user_id = ? AND item_type = 'history'")
        .bind(principal.userId),
    );
  }
  await env.DB.batch(statements);
  return noStoreJson({ requestId, settings: await readSettings(env, principal.userId) });
}

function invalidSettings(): never {
  throw new ApiError(400, "INVALID_REQUEST", false, "The sync settings are invalid.");
}

async function pull(env: AppEnv, requestId: string, principal: Principal, url: URL): Promise<Response> {
  const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
  const limit = Math.min(
    MAX_PAGE_ITEMS,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
  );
  const rows = await env.DB.prepare(
    `SELECT c.seq, r.item_id, r.item_type, r.version, r.key_version, r.nonce, r.ciphertext,
            r.deleted, r.modified_at
     FROM sync_record_changes c
     JOIN sync_records r ON r.user_id = c.user_id AND r.item_type = c.item_type AND r.item_id = c.item_id
     WHERE c.user_id = ? AND c.seq > ?
     ORDER BY c.seq ASC LIMIT ?`,
  ).bind(principal.userId, cursor, limit).all<RecordRow & { seq: number }>();
  const needsKey = rows.results.some((row) => row.deleted === 0);
  const dataKey = needsKey ? await accountDataKey(env, principal.userId, false) : null;
  const items = await Promise.all(rows.results.map((row) => publicRecord(principal.userId, row, dataKey)));
  const nextCursor = rows.results.reduce((latest, row) => Math.max(latest, row.seq), cursor);
  await recordActivity(env, {
    userId: principal.userId,
    type: "sync_pulled",
    requestId,
    statusCode: 200,
    itemCount: items.length,
  });
  return noStoreJson({
    requestId,
    nextCursor,
    hasMore: rows.results.length === limit,
    items,
    settings: cursor === 0 || rows.results.length < limit
      ? await readSettings(env, principal.userId)
      : undefined,
  });
}

async function push(request: Request, env: AppEnv, requestId: string, principal: Principal): Promise<Response> {
  const body = await readJson<{ items?: unknown }>(request, 4_194_304);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_BATCH_ITEMS) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Send between 1 and 100 sync records.");
  }
  const writes = body.items.map(validateWrite);
  if (new Set(writes.map((item) => `${item.type}:${item.id}`)).size !== writes.length) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Each record may appear only once per batch.");
  }
  const settings = await readSettings(env, principal.userId);
  if (!settings.historySyncEnabled && writes.some((item) => item.type === "history" && !item.deleted)) {
    throw new ApiError(409, "HISTORY_SYNC_DISABLED", false, "History sync is turned off for this account.");
  }

  const current = await Promise.all(writes.map((item) => env.DB.prepare(
    "SELECT * FROM sync_records WHERE user_id = ? AND item_type = ? AND item_id = ?",
  ).bind(principal.userId, item.type, item.id).first<RecordRow>()));
  const conflicts = writes.flatMap((item, index) => {
    const row = current[index];
    return (row?.version ?? 0) === item.baseVersion ? [] : [{ item, row }];
  });
  if (conflicts.length) {
    const dataKey = conflicts.some(({ row }) => row && row.deleted === 0)
      ? await accountDataKey(env, principal.userId, false)
      : null;
    return conflictResponse(env, requestId, principal, await Promise.all(conflicts.map(({ item, row }) =>
      row ? publicRecord(principal.userId, row, dataKey) : { id: item.id, type: item.type, version: 0, deleted: false, payload: null })));
  }

  const newDictionaryTerms = writes.filter((item, index) =>
    item.type === "dictionary" && !item.deleted && (!current[index] || current[index]!.deleted === 1)).length;
  if (newDictionaryTerms > 0) {
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sync_records WHERE user_id = ? AND item_type = 'dictionary' AND deleted = 0",
    ).bind(principal.userId).first<{ count: number }>();
    if ((stored?.count ?? 0) + newDictionaryTerms > RECORD_LIMITS.dictionary) {
      throw new ApiError(413, "STORAGE_LIMIT_REACHED", false, "Your dictionary has reached its 1,000-term limit.");
    }
  }

  const dataKey = writes.some((item) => !item.deleted) ? await accountDataKey(env, principal.userId, true) : null;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const applied: Array<{ id: string; type: RecordType; version: number }> = [];
  for (const item of writes) {
    const version = item.baseVersion + 1;
    const sealed = item.deleted || !dataKey
      ? null
      : await sealBytes(dataKey, new TextEncoder().encode(JSON.stringify(item.payload)), recordAad(principal.userId, item));
    statements.push(
      env.DB.prepare(
        `INSERT INTO sync_records
          (user_id, item_type, item_id, version, key_version, nonce, ciphertext, deleted, created_at, modified_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
           version = excluded.version, key_version = excluded.key_version, nonce = excluded.nonce,
           ciphertext = excluded.ciphertext, deleted = excluded.deleted,
           created_at = CASE WHEN excluded.deleted = 1 THEN sync_records.created_at ELSE excluded.created_at END,
           modified_at = excluded.modified_at`,
      ).bind(
        principal.userId,
        item.type,
        item.id,
        version,
        sealed ? DATA_KEY_VERSION : null,
        sealed?.nonce ?? null,
        sealed?.ciphertext ?? null,
        item.deleted ? 1 : 0,
        item.createdAt,
        now,
      ),
      changeStatement(env, principal.userId, item.type, item.id, now),
    );
    applied.push({ id: item.id, type: item.type, version });
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("SYNC_CONFLICT")) throw error;
    // Another device won a race after the version check above.
    const latest = await Promise.all(writes.map((item) => env.DB.prepare(
      "SELECT * FROM sync_records WHERE user_id = ? AND item_type = ? AND item_id = ?",
    ).bind(principal.userId, item.type, item.id).first<RecordRow>()));
    const rows = latest.filter((row): row is RecordRow => row !== null);
    const key = rows.some((row) => row.deleted === 0) ? await accountDataKey(env, principal.userId, false) : null;
    return conflictResponse(env, requestId, principal, await Promise.all(rows.map((row) => publicRecord(principal.userId, row, key))));
  }
  for (const type of ["history", "analytics"] as const) {
    if (writes.some((item) => item.type === type && !item.deleted)) await pruneOldest(env, principal.userId, type);
  }
  await recordActivity(env, {
    userId: principal.userId,
    type: "sync_pushed",
    requestId,
    statusCode: 200,
    itemCount: applied.length,
  });
  return noStoreJson({ requestId, applied });
}

async function conflictResponse(
  env: AppEnv,
  requestId: string,
  principal: Principal,
  conflicts: object[],
): Promise<Response> {
  await recordActivity(env, {
    userId: principal.userId,
    type: "sync_conflict",
    requestId,
    statusCode: 409,
    outcomeCode: "SYNC_CONFLICT",
    itemCount: conflicts.length,
  });
  const response = errorResponse(
    new ApiError(409, "SYNC_CONFLICT", false, "One or more records changed on another device."),
    requestId,
  );
  const value = await response.json() as Record<string, unknown>;
  return noStoreJson({ ...value, conflicts }, { status: 409 });
}

function changeStatement(env: AppEnv, userId: string, type: string, id: string, now: number): D1PreparedStatement {
  // REPLACE deletes the record's previous change row and appends a new one at the
  // end of the feed, so each record has exactly one row at its latest write.
  return env.DB.prepare(
    "INSERT OR REPLACE INTO sync_record_changes(user_id, item_type, item_id, created_at) VALUES(?, ?, ?, ?)",
  ).bind(userId, type, id, now);
}

/** Deletes (with tombstones, so devices follow) the oldest records beyond the type's ceiling. */
async function pruneOldest(env: AppEnv, userId: string, type: "history" | "analytics"): Promise<void> {
  const stored = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sync_records WHERE user_id = ? AND item_type = ? AND deleted = 0",
  ).bind(userId, type).first<{ count: number }>();
  const excess = (stored?.count ?? 0) - RECORD_LIMITS[type];
  if (excess <= 0) return;
  const oldest = await env.DB.prepare(
    `SELECT item_id FROM sync_records WHERE user_id = ? AND item_type = ? AND deleted = 0
     ORDER BY created_at ASC LIMIT ?`,
  ).bind(userId, type, Math.min(excess, 200)).all<{ item_id: string }>();
  await tombstone(env, userId, type, oldest.results.map((row) => row.item_id));
}

async function tombstone(env: AppEnv, userId: string, type: RecordType, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = Date.now();
  await env.DB.batch(ids.flatMap((id) => [
    env.DB.prepare(
      `UPDATE sync_records SET version = version + 1, deleted = 1, nonce = NULL, ciphertext = NULL,
         key_version = NULL, modified_at = ?
       WHERE user_id = ? AND item_type = ? AND item_id = ? AND deleted = 0`,
    ).bind(now, userId, type, id),
    changeStatement(env, userId, type, id, now),
  ]));
}

/** Scheduled: deletes history older than each account's chosen retention, everywhere. */
export async function applyHistoryRetention(env: AppEnv, limit = 500): Promise<number> {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT r.user_id, r.item_id FROM sync_records r JOIN users u ON u.id = r.user_id
     WHERE r.item_type = 'history' AND r.deleted = 0 AND u.history_retention_days IS NOT NULL
       AND r.created_at < ? - u.history_retention_days * 86400000
     LIMIT ?`,
  ).bind(now, limit).all<{ user_id: string; item_id: string }>();
  const byUser = new Map<string, string[]>();
  for (const row of expired.results) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.item_id]);
  for (const [userId, ids] of byUser) await tombstone(env, userId, "history", ids);
  return expired.results.length;
}

/**
 * Scheduled: removes v1 (recovery-key vault) ciphertext for accounts that finished
 * migrating more than 30 days ago, or for every account once v1 sync is sunset.
 */
export async function purgeLegacyVaults(env: AppEnv, limit = 50): Promise<number> {
  const now = Date.now();
  const sunset = v1Sunset(env, now);
  const accounts = await env.DB.prepare(
    `SELECT id FROM users
     WHERE wrapped_vault_key IS NOT NULL
       AND ((sync_v1_migrated_at IS NOT NULL AND sync_v1_migrated_at < ?) OR ?)
     LIMIT ?`,
  ).bind(now - V1_PURGE_GRACE_MS, sunset ? 1 : 0, limit).all<{ id: string }>();
  for (const { id } of accounts.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_changes WHERE user_id = ?").bind(id),
      env.DB.prepare("DELETE FROM sync_items WHERE user_id = ?").bind(id),
      env.DB.prepare(
        "UPDATE users SET wrapped_vault_key = NULL, wrapped_vault_nonce = NULL, vault_key_version = NULL WHERE id = ?",
      ).bind(id),
    ]);
  }
  return accounts.results.length;
}

/** True once v1 sync is closed for every account (SYNC_V1_SUNSET_AT has passed). */
export function v1Sunset(env: AppEnv, now = Date.now()): boolean {
  if (!env.SYNC_V1_SUNSET_AT) return false;
  const sunset = Date.parse(env.SYNC_V1_SUNSET_AT);
  return Number.isFinite(sunset) && now >= sunset;
}

/**
 * The account's AES-GCM data key. Created on first write, stored wrapped by the
 * current SYNC_KEK, and re-wrapped lazily after a SYNC_KEK rotation.
 */
async function accountDataKey(env: AppEnv, userId: string, create: boolean): Promise<CryptoKey | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await env.DB.prepare(
      "SELECT data_key_wrapped, data_key_nonce, data_key_kek_version FROM users WHERE id = ?",
    ).bind(userId).first<{
      data_key_wrapped: string | null;
      data_key_nonce: string | null;
      data_key_kek_version: number | null;
    }>();
    if (!row) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
    const currentVersion = kekVersion(env);
    if (row.data_key_wrapped && row.data_key_nonce && row.data_key_kek_version !== null) {
      const raw = await openBytes(
        await kek(env, row.data_key_kek_version),
        row.data_key_nonce,
        row.data_key_wrapped,
        dataKeyAad(userId, row.data_key_kek_version),
      );
      if (row.data_key_kek_version !== currentVersion) {
        const rewrapped = await sealBytes(await kek(env, currentVersion), raw, dataKeyAad(userId, currentVersion));
        await env.DB.prepare(
          `UPDATE users SET data_key_wrapped = ?, data_key_nonce = ?, data_key_kek_version = ?
           WHERE id = ? AND data_key_kek_version = ?`,
        ).bind(rewrapped.ciphertext, rewrapped.nonce, currentVersion, userId, row.data_key_kek_version).run();
      }
      return importAesKey(raw);
    }
    if (!create) return null;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await sealBytes(await kek(env, currentVersion), raw, dataKeyAad(userId, currentVersion));
    const stored = await env.DB.prepare(
      `UPDATE users SET data_key_wrapped = ?, data_key_nonce = ?, data_key_kek_version = ?
       WHERE id = ? AND data_key_wrapped IS NULL`,
    ).bind(wrapped.ciphertext, wrapped.nonce, currentVersion, userId).run();
    if ((stored.meta.changes ?? 0) === 1) return importAesKey(raw);
    // Another request created the key first; use that one.
  }
  throw new ApiError(500, "INFERENCE_FAILED", true, "The sync key could not be prepared. Please try again.");
}

function kekVersion(env: AppEnv): number {
  const version = Number.parseInt(env.SYNC_KEK_VERSION ?? "1", 10);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

async function kek(env: AppEnv, version: number): Promise<CryptoKey> {
  const current = kekVersion(env);
  const secret = version === current
    ? env.SYNC_KEK
    : version === current - 1 ? env.SYNC_KEK_PREVIOUS : undefined;
  if (!secret) throw new Error(`SYNC_KEK version ${version} is not configured`);
  return importAesKey(fromBase64Url(secret));
}

function dataKeyAad(userId: string, version: number): string {
  return `wovoice-data-key|${userId}|${version}`;
}

function recordAad(userId: string, item: { type: string; id: string }): string {
  return `wovoice-record|${userId}|${item.type}|${item.id}`;
}

async function publicRecord(userId: string, row: RecordRow, dataKey: CryptoKey | null): Promise<object> {
  let payload: unknown = null;
  if (row.deleted === 0 && row.nonce && row.ciphertext && dataKey) {
    try {
      const plaintext = await openBytes(dataKey, row.nonce, row.ciphertext, recordAad(userId, {
        type: row.item_type,
        id: row.item_id,
      }));
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      console.error(JSON.stringify({ event: "sync_record_unreadable", reason: safeFailure(error) }));
    }
  }
  return {
    id: row.item_id,
    type: row.item_type,
    version: row.version,
    deleted: row.deleted === 1,
    payload,
    modifiedAt: row.modified_at,
  };
}

function validateWrite(value: unknown): RecordWrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRecord();
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" && /^[A-Za-z0-9._~-]{1,100}$/u.test(item.id) ? item.id : invalidRecord();
  const type = typeof item.type === "string" && RECORD_TYPES.has(item.type as RecordType)
    ? item.type as RecordType
    : invalidRecord();
  const baseVersion = typeof item.baseVersion === "number" && Number.isSafeInteger(item.baseVersion) && item.baseVersion >= 0
    ? item.baseVersion
    : invalidRecord();
  const deleted = item.deleted === true;
  if (deleted) return { id, type, baseVersion, deleted, payload: null, createdAt: Date.now() };
  const payload = item.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidRecord();
  const record = payload as Record<string, unknown>;
  if (JSON.stringify(record).length > MAX_PAYLOAD_CHARS) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", false, "A sync record is too large.");
  }
  const createdAt = finiteTime(record.createdAtMs);
  if (type === "history") {
    if (typeof record.text !== "string" || record.text.length > 20_000 || createdAt === null) invalidRecord();
  } else if (type === "dictionary") {
    if (typeof record.term !== "string" || record.term.trim().length < 1 || record.term.length > 80) invalidRecord();
    if (typeof record.normalizedTerm !== "string" || record.normalizedTerm.length < 1 || record.normalizedTerm.length > 160) {
      invalidRecord();
    }
  } else if (createdAt === null) {
    invalidRecord();
  }
  return { id, type, baseVersion, deleted, payload: record, createdAt: createdAt ?? Date.now() };
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function invalidRecord(): never {
  throw new ApiError(400, "INVALID_REQUEST", false, "A sync record is invalid.");
}

