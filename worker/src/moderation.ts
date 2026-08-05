import { ApiError } from "./errors";
import { decryptString } from "./crypto";
import type { AccountRole, AccountState, AdminServices, AppEnv, Principal } from "./types";

const BASE_DAILY_AUDIO_SECONDS = 600;
const DETAIL_RETENTION_MS = 90 * 86_400_000;
const AGGREGATE_RETENTION_MS = 397 * 86_400_000;

export interface AccountControlRow {
  id: string;
  role: AccountRole;
  status: AccountState;
  suspended_until: number | null;
  public_status_message: string | null;
  quota_limit_audio_seconds: number | null;
  quota_override_expires_at: number | null;
}

export interface ActivityEvent {
  userId: string;
  type:
    | "account_created"
    | "login_succeeded"
    | "logout"
    | "session_revoked"
    | "transcription_succeeded"
    | "transcription_failed"
    | "quota_rejected"
    | "sync_pulled"
    | "sync_pushed"
    | "sync_conflict"
    | "account_restricted"
    | "account_restored";
  requestId?: string;
  statusCode?: number;
  outcomeCode?: string;
  model?: string;
  audioSeconds?: number;
  estimatedNeurons?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  itemCount?: number;
  deviceName?: string;
  createdAt?: number;
}

export function accountStatusValue(row: Pick<AccountControlRow, "status" | "suspended_until" | "public_status_message">): {
  state: AccountState;
  suspendedUntil: number | null;
  publicMessage: string | null;
} {
  return {
    state: row.status,
    suspendedUntil: row.status === "suspended" ? row.suspended_until : null,
    publicMessage: row.status === "active" ? null : row.public_status_message,
  };
}

export function effectiveDailyAudioLimit(
  row: Pick<AccountControlRow, "quota_limit_audio_seconds" | "quota_override_expires_at">,
  now = Date.now(),
): number {
  return row.quota_limit_audio_seconds !== null
      && row.quota_override_expires_at !== null
      && row.quota_override_expires_at > now
    ? row.quota_limit_audio_seconds
    : BASE_DAILY_AUDIO_SECONDS;
}

export async function requireActiveAccount(env: AppEnv, principal: Principal): Promise<Principal> {
  const current = await refreshExpiredStatus(env, principal);
  if (current.accountState === "suspended") {
    throw new ApiError(
      403,
      "ACCOUNT_SUSPENDED",
      false,
      current.publicStatusMessage || "This WoVoice account is temporarily suspended.",
      current.suspendedUntil ? Math.max(1, Math.ceil((current.suspendedUntil - Date.now()) / 1_000)) : undefined,
    );
  }
  if (current.accountState === "banned") {
    throw new ApiError(
      403,
      "ACCOUNT_BANNED",
      false,
      current.publicStatusMessage || "This WoVoice account is not permitted to use cloud services.",
    );
  }
  return current;
}

export async function recheckActiveAccount(env: AppEnv, principal: Principal): Promise<Principal> {
  return requireActiveAccount(env, await currentPrincipalStatus(env, principal));
}

export async function refreshExpiredStatus(env: AppEnv, principal: Principal): Promise<Principal> {
  if (principal.accountState !== "suspended" || !principal.suspendedUntil || principal.suspendedUntil > Date.now()) {
    return principal;
  }
  const restored = await restoreExpiredAccount(env, principal.userId, Date.now());
  return restored
    ? { ...principal, accountState: "active", suspendedUntil: null, publicStatusMessage: null }
    : currentPrincipalStatus(env, principal);
}

async function currentPrincipalStatus(env: AppEnv, principal: Principal): Promise<Principal> {
  const row = await env.DB.prepare(
    "SELECT role, status, suspended_until, public_status_message FROM users WHERE id = ?",
  ).bind(principal.userId).first<{
    role: AccountRole;
    status: AccountState;
    suspended_until: number | null;
    public_status_message: string | null;
  }>();
  if (!row) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  return {
    ...principal,
    role: row.role,
    accountState: row.status,
    suspendedUntil: row.suspended_until,
    publicStatusMessage: row.public_status_message,
  };
}

export async function restoreExpiredAccount(env: AppEnv, userId: string, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE users SET status = 'active', suspended_until = NULL, public_status_message = NULL,
       status_changed_at = ?
     WHERE id = ? AND status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= ?`,
  ).bind(now, userId, now).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  const requestId = crypto.randomUUID();
  const notificationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_audit_events
        (id, actor_user_id, target_user_id, action, internal_reason, before_state, after_state, request_id, created_at)
       VALUES(?, NULL, ?, 'suspension_expired', 'Automatic suspension expiry', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      JSON.stringify({ status: "suspended" }),
      JSON.stringify({ status: "active" }),
      requestId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO moderation_notifications
        (id, user_id, action, public_message, effective_until, status, attempts,
         next_attempt_at, created_at, updated_at)
       VALUES(?, ?, 'active', 'Your WoVoice account access has been restored.', NULL, 'pending', 0, ?, ?, ?)`,
    ).bind(notificationId, userId, now, now, now),
  ]);
  await recordActivity(env, { userId, type: "account_restored", requestId, statusCode: 200, createdAt: now });
  return true;
}

export async function recordActivity(env: AppEnv, event: ActivityEvent): Promise<void> {
  const now = event.createdAt ?? Date.now();
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT OR IGNORE INTO service_daily_aggregates(date_key) VALUES(?)").bind(dateKey),
    env.DB.prepare(
      "UPDATE users SET last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END WHERE id = ?",
    ).bind(now, now, event.userId),
    env.DB.prepare("INSERT OR IGNORE INTO service_daily_active_users(date_key, user_id) VALUES(?, ?)")
      .bind(dateKey, event.userId),
    env.DB.prepare(
      `INSERT INTO user_activity_events
        (id, user_id, event_type, request_id, status_code, outcome_code, model, audio_seconds,
         estimated_neurons, estimated_cost_usd, latency_ms, item_count, device_name, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      event.userId,
      event.type,
      event.requestId ?? null,
      event.statusCode ?? null,
      event.outcomeCode?.slice(0, 80) ?? null,
      event.model?.slice(0, 80) ?? null,
      finiteOrNull(event.audioSeconds),
      finiteOrNull(event.estimatedNeurons),
      finiteOrNull(event.estimatedCostUsd),
      integerOrNull(event.latencyMs),
      integerOrNull(event.itemCount),
      event.deviceName?.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 80) ?? null,
      now,
    ),
  ];

  if (event.type === "account_created") {
    statements.push(env.DB.prepare(
      "UPDATE service_daily_aggregates SET registered_users = registered_users + 1 WHERE date_key = ?",
    ).bind(dateKey));
  } else if (event.type === "login_succeeded") {
    statements.push(env.DB.prepare(
      "UPDATE service_daily_aggregates SET login_successes = login_successes + 1 WHERE date_key = ?",
    ).bind(dateKey));
  } else if (event.type === "transcription_succeeded") {
    statements.push(env.DB.prepare(
      `UPDATE service_daily_aggregates SET
         transcriptions_succeeded = transcriptions_succeeded + 1,
         audio_seconds = audio_seconds + ?,
         estimated_neurons = estimated_neurons + ?,
         estimated_cost_usd = estimated_cost_usd + ?,
         total_latency_ms = total_latency_ms + ?, latency_samples = latency_samples + 1
       WHERE date_key = ?`,
    ).bind(
      finite(event.audioSeconds),
      finite(event.estimatedNeurons),
      finite(event.estimatedCostUsd),
      integer(event.latencyMs),
      dateKey,
    ));
  } else if (event.type === "transcription_failed") {
    statements.push(env.DB.prepare(
      `UPDATE service_daily_aggregates SET transcriptions_failed = transcriptions_failed + 1,
         total_latency_ms = total_latency_ms + ?, latency_samples = latency_samples + 1
       WHERE date_key = ?`,
    ).bind(integer(event.latencyMs), dateKey));
  } else if (event.type === "quota_rejected") {
    statements.push(env.DB.prepare(
      "UPDATE service_daily_aggregates SET quota_rejections = quota_rejections + 1 WHERE date_key = ?",
    ).bind(dateKey));
  } else if (event.type === "sync_pulled" || event.type === "sync_pushed" || event.type === "sync_conflict") {
    statements.push(env.DB.prepare(
      "UPDATE service_daily_aggregates SET sync_operations = sync_operations + 1 WHERE date_key = ?",
    ).bind(dateKey));
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({
      event: "activity_record_failed",
      requestId: event.requestId ?? null,
      activityType: event.type,
      reason: safeFailure(error),
    }));
  }
}

export async function processModerationNotifications(
  env: AppEnv,
  services: AdminServices,
  limit = 10,
): Promise<number> {
  const now = Date.now();
  const pending = await env.DB.prepare(
    `SELECT n.id, n.user_id, n.action, n.public_message, n.effective_until, n.attempts,
            u.email_ciphertext, u.email_nonce
     FROM moderation_notifications n JOIN users u ON u.id = n.user_id
     WHERE n.status = 'pending' AND n.next_attempt_at <= ?
     ORDER BY n.created_at ASC LIMIT ?`,
  ).bind(now, Math.min(25, Math.max(1, limit))).all<{
    id: string;
    user_id: string;
    action: AccountState;
    public_message: string;
    effective_until: number | null;
    attempts: number;
    email_ciphertext: string;
    email_nonce: string;
  }>();

  for (const notification of pending.results) {
    const monthKey = new Date(now).toISOString().slice(0, 7);
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO service_monthly_usage(month_key, verification_emails, moderation_emails) VALUES(?, 0, 0)",
        ).bind(monthKey),
        env.DB.prepare(
          "UPDATE service_monthly_usage SET moderation_emails = moderation_emails + 1 WHERE month_key = ?",
        ).bind(monthKey),
      ]);
      const email = await decryptString(env.PII_KEY, notification.email_ciphertext, notification.email_nonce);
      await services.sendModerationEmail(env, {
        to: email,
        state: notification.action,
        publicMessage: notification.public_message,
        effectiveUntil: notification.effective_until,
      });
      await env.DB.prepare(
        `UPDATE moderation_notifications SET status = 'sent', attempts = attempts + 1,
           last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).bind(Date.now(), Date.now(), notification.id).run();
    } catch (error) {
      const attempts = notification.attempts + 1;
      const failed = attempts >= 3;
      const backoff = attempts === 1 ? 5 * 60_000 : attempts === 2 ? 30 * 60_000 : 2 * 60 * 60_000;
      await env.DB.prepare(
        `UPDATE moderation_notifications SET status = ?, attempts = ?, next_attempt_at = ?,
           last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ).bind(
        failed ? "failed" : "pending",
        attempts,
        Date.now() + backoff,
        safeFailure(error),
        Date.now(),
        notification.id,
      ).run();
    }
  }
  return pending.results.length;
}

export async function reactivateExpiredSuspensions(env: AppEnv, limit = 50): Promise<number> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id FROM users WHERE status = 'suspended' AND suspended_until IS NOT NULL
     AND suspended_until <= ? ORDER BY suspended_until ASC LIMIT ?`,
  ).bind(now, Math.min(100, Math.max(1, limit))).all<{ id: string }>();
  let restored = 0;
  for (const row of rows.results) if (await restoreExpiredAccount(env, row.id, now)) restored += 1;
  return restored;
}

export async function cleanupModerationData(env: AppEnv, now = Date.now()): Promise<void> {
  const detailCutoff = now - DETAIL_RETENTION_MS;
  const detailDate = new Date(detailCutoff).toISOString().slice(0, 10);
  const aggregateDate = new Date(now - AGGREGATE_RETENTION_MS).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_activity_events WHERE created_at < ?").bind(detailCutoff),
    env.DB.prepare("DELETE FROM admin_audit_events WHERE created_at < ?").bind(detailCutoff),
    env.DB.prepare("DELETE FROM moderation_notifications WHERE created_at < ? AND status != 'pending'").bind(detailCutoff),
    env.DB.prepare("DELETE FROM daily_usage WHERE date_key < ?").bind(detailDate),
    env.DB.prepare("DELETE FROM service_daily_active_users WHERE date_key < ?").bind(detailDate),
    env.DB.prepare("DELETE FROM service_daily_aggregates WHERE date_key < ?").bind(aggregateDate),
  ]);
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function finiteOrNull(value: number | undefined): number | null {
  return value === undefined ? null : finite(value);
}

function integer(value: number | undefined): number {
  return Math.round(finite(value));
}

function integerOrNull(value: number | undefined): number | null {
  return value === undefined ? null : integer(value);
}

function safeFailure(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/[A-Za-z0-9_-]{30,}/gu, "[redacted-value]")
    .slice(0, 240);
}
