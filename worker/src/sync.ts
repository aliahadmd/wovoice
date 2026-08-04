import { authenticateAccess } from "./auth";
import { ApiError, errorResponse } from "./errors";
import { noStoreJson, readJson } from "./http";
import type { AppEnv } from "./types";

const ITEM_TYPES = new Set(["history", "dictionary", "analytics"]);
const MAX_BATCH_ITEMS = 100;
const MAX_CIPHERTEXT_CHARS = 90_000;

interface SyncWrite {
  id?: unknown;
  type?: unknown;
  baseVersion?: unknown;
  keyVersion?: unknown;
  nonce?: unknown;
  ciphertext?: unknown;
  deleted?: unknown;
}

interface SyncItemRow {
  item_id: string;
  item_type: string;
  version: number;
  key_version: number;
  nonce: string | null;
  ciphertext: string | null;
  deleted: number;
  modified_at: number;
}

export async function handleSyncRoute(request: Request, env: AppEnv, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/sync")) return null;
  const principal = await authenticateAccess(request, env);
  if (request.method === "GET" && url.pathname === "/v1/sync/vault") {
    const row = await env.DB.prepare(
      "SELECT wrapped_vault_key, wrapped_vault_nonce, vault_key_version FROM users WHERE id = ?",
    ).bind(principal.userId).first<{
      wrapped_vault_key: string | null;
      wrapped_vault_nonce: string | null;
      vault_key_version: number | null;
    }>();
    return noStoreJson({
      requestId,
      vault: row?.wrapped_vault_key
        ? { wrappedKey: row.wrapped_vault_key, nonce: row.wrapped_vault_nonce, keyVersion: row.vault_key_version }
        : null,
    });
  }
  if (request.method === "PUT" && url.pathname === "/v1/sync/vault") {
    const body = await readJson<{
      wrappedKey?: unknown;
      nonce?: unknown;
      keyVersion?: unknown;
      expectedKeyVersion?: unknown;
    }>(request);
    const wrappedKey = encoded(body.wrappedKey, 2_048, "wrapped vault key");
    const nonce = encoded(body.nonce, 64, "vault nonce");
    const keyVersion = positiveInteger(body.keyVersion, "vault key version");
    const expected = body.expectedKeyVersion === null || body.expectedKeyVersion === undefined
      ? null
      : positiveInteger(body.expectedKeyVersion, "expected key version");
    const current = await env.DB.prepare("SELECT vault_key_version FROM users WHERE id = ?")
      .bind(principal.userId)
      .first<{ vault_key_version: number | null }>();
    if (!current || current.vault_key_version !== expected) {
      throw new ApiError(409, "SYNC_CONFLICT", false, "The encrypted vault changed on another device.");
    }
    await env.DB.prepare(
      "UPDATE users SET wrapped_vault_key = ?, wrapped_vault_nonce = ?, vault_key_version = ? WHERE id = ?",
    ).bind(wrappedKey, nonce, keyVersion, principal.userId).run();
    return noStoreJson({ requestId, keyVersion });
  }
  if (request.method === "DELETE" && url.pathname === "/v1/sync/vault") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sync_changes WHERE user_id = ?").bind(principal.userId),
      env.DB.prepare("DELETE FROM sync_items WHERE user_id = ?").bind(principal.userId),
      env.DB.prepare(
        "UPDATE users SET wrapped_vault_key = NULL, wrapped_vault_nonce = NULL, vault_key_version = NULL WHERE id = ?",
      ).bind(principal.userId),
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
        .bind(Date.now(), principal.userId, principal.sessionId),
    ]);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "GET" && url.pathname === "/v1/sync") {
    const cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
    const limit = Math.min(MAX_BATCH_ITEMS, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
    const rows = await env.DB.prepare(
      `SELECT c.seq, i.item_id, i.item_type, i.version, i.key_version, i.nonce,
              i.ciphertext, i.deleted, i.modified_at
       FROM sync_changes c
       JOIN sync_items i ON i.user_id = c.user_id AND i.item_type = c.item_type AND i.item_id = c.item_id
       WHERE c.user_id = ? AND c.seq > ?
       ORDER BY c.seq ASC LIMIT ?`,
    ).bind(principal.userId, cursor, limit).all<SyncItemRow & { seq: number }>();
    const nextCursor = rows.results.reduce((latest, row) => Math.max(latest, row.seq), cursor);
    return noStoreJson({
      requestId,
      nextCursor,
      hasMore: rows.results.length === limit,
      items: rows.results.map(publicSyncItem),
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/sync/batch") {
    const body = await readJson<{ items?: unknown }>(request, 1_048_576);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_BATCH_ITEMS) {
      throw new ApiError(400, "INVALID_REQUEST", false, "Send between 1 and 100 encrypted sync items.");
    }
    const writes = body.items.map(validateWrite);
    const vault = await env.DB.prepare("SELECT vault_key_version FROM users WHERE id = ?")
      .bind(principal.userId)
      .first<{ vault_key_version: number | null }>();
    if (!vault?.vault_key_version || writes.some((item) => item.keyVersion !== vault.vault_key_version)) {
      throw new ApiError(409, "SYNC_CONFLICT", false, "The encrypted vault key changed. Recover or reset the vault.");
    }
    const currentRows = await Promise.all(
      writes.map((item) => env.DB.prepare(
        "SELECT * FROM sync_items WHERE user_id = ? AND item_type = ? AND item_id = ?",
      ).bind(principal.userId, item.type, item.id).first<SyncItemRow>()),
    );
    const conflicts = writes.flatMap((item, index) => {
      const current = currentRows[index];
      const currentVersion = current?.version ?? 0;
      return currentVersion === item.baseVersion ? [] : [current ? publicSyncItem(current) : { id: item.id, type: item.type, version: 0 }];
    });
    if (conflicts.length) {
      const response = errorResponse(
        new ApiError(409, "SYNC_CONFLICT", false, "One or more encrypted records changed on another device."),
        requestId,
      );
      const value = await response.json() as Record<string, unknown>;
      return noStoreJson({ ...value, conflicts }, { status: 409 });
    }

    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    const applied: Array<{ id: string; type: string; version: number }> = [];
    for (const item of writes) {
      const version = item.baseVersion + 1;
      statements.push(
        env.DB.prepare(
          `INSERT INTO sync_items
            (user_id, item_type, item_id, version, key_version, nonce, ciphertext, deleted, modified_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
             version = excluded.version, key_version = excluded.key_version, nonce = excluded.nonce,
             ciphertext = excluded.ciphertext, deleted = excluded.deleted, modified_at = excluded.modified_at`,
        ).bind(
          principal.userId,
          item.type,
          item.id,
          version,
          item.keyVersion,
          item.deleted ? null : item.nonce,
          item.deleted ? null : item.ciphertext,
          item.deleted ? 1 : 0,
          now,
        ),
      );
      statements.push(
        env.DB.prepare(
          "INSERT INTO sync_changes(user_id, item_type, item_id, created_at) VALUES(?, ?, ?, ?)",
        ).bind(principal.userId, item.type, item.id, now),
      );
      applied.push({ id: item.id, type: item.type, version });
    }
    try {
      await env.DB.batch(statements);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("SYNC_CONFLICT")) throw error;
      const latest = await Promise.all(
        writes.map((item) => env.DB.prepare(
          "SELECT * FROM sync_items WHERE user_id = ? AND item_type = ? AND item_id = ?",
        ).bind(principal.userId, item.type, item.id).first<SyncItemRow>()),
      );
      const response = errorResponse(
        new ApiError(409, "SYNC_CONFLICT", false, "One or more encrypted records changed on another device."),
        requestId,
      );
      const value = await response.json() as Record<string, unknown>;
      return noStoreJson({ ...value, conflicts: latest.filter(Boolean).map((item) => publicSyncItem(item!)) }, { status: 409 });
    }
    return noStoreJson({ requestId, applied });
  }
  return null;
}

function validateWrite(value: unknown): Required<SyncWrite> & {
  id: string;
  type: string;
  baseVersion: number;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  deleted: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidItem();
  const item = value as SyncWrite;
  const id = typeof item.id === "string" && /^[A-Za-z0-9._~-]{1,100}$/u.test(item.id) ? item.id : invalidItem();
  const type = typeof item.type === "string" && ITEM_TYPES.has(item.type) ? item.type : invalidItem();
  const baseVersion = nonNegativeInteger(item.baseVersion, "base version");
  const keyVersion = positiveInteger(item.keyVersion, "key version");
  const deleted = item.deleted === true;
  const nonce = deleted ? "" : encoded(item.nonce, 64, "nonce");
  const ciphertext = deleted ? "" : encoded(item.ciphertext, MAX_CIPHERTEXT_CHARS, "ciphertext");
  return { id, type, baseVersion, keyVersion, nonce, ciphertext, deleted };
}

function publicSyncItem(row: SyncItemRow): object {
  return {
    id: row.item_id,
    type: row.item_type,
    version: row.version,
    keyVersion: row.key_version,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    deleted: row.deleted === 1,
    modifiedAt: row.modified_at,
  };
}

function encoded(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApiError(400, "INVALID_REQUEST", false, `The encrypted ${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_REQUEST", false, `The ${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_REQUEST", false, `The ${label} is invalid.`);
  }
  return value;
}

function invalidItem(): never {
  throw new ApiError(400, "INVALID_REQUEST", false, "An encrypted sync item is invalid.");
}
