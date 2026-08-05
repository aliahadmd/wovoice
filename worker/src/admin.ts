import { createRemoteJWKSet, jwtVerify } from "jose";
import { ApiError } from "./errors";
import { base64Url, decryptString, fromBase64Url, hmac } from "./crypto";
import { noStoreJson, readJson } from "./http";
import {
  accountStatusValue,
  effectiveDailyAudioLimit,
  processModerationNotifications,
  recordActivity,
  type AccountControlRow,
} from "./moderation";
import type { AccountRole, AccountState, AdminIdentity, AdminServices, AppEnv } from "./types";

const MAX_SUSPENSION_MS = 180 * 86_400_000;
const MAX_QUOTA_OVERRIDE_MS = 30 * 86_400_000;
const MAX_PAGE_SIZE = 100;
const ADMIN_ASSET_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

type Jwks = ReturnType<typeof createRemoteJWKSet>;
const jwksByTeam = new Map<string, Jwks>();

interface AdminPrincipal {
  userId: string;
  email: string;
  role: "admin";
}

interface AdminUserRow extends AccountControlRow {
  email_ciphertext: string;
  email_nonce: string;
  created_at: number;
  verified_at: number;
  terms_version: string;
  last_activity_at: number | null;
  session_count?: number;
  today_audio_seconds?: number;
  used_audio_seconds_90d?: number;
  request_count_90d?: number;
  sync_item_count?: number;
}

export const productionAdminServices: AdminServices = {
  async verifyAccessJwt(env, token): Promise<AdminIdentity> {
    const teamDomain = normalizedTeamDomain(env.ACCESS_TEAM_DOMAIN);
    const audience = env.ACCESS_AUD?.trim();
    if (!teamDomain || !audience) {
      console.error(JSON.stringify({ event: "admin_access_unconfigured" }));
      throw new ApiError(503, "ADMIN_REQUIRED", true, "The WoVoice admin console is not configured.");
    }
    let jwks = jwksByTeam.get(teamDomain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      jwksByTeam.set(teamDomain, jwks);
    }
    try {
      const result = await jwtVerify(token, jwks, { issuer: teamDomain, audience });
      const email = typeof result.payload.email === "string" ? normalizeEmail(result.payload.email) : "";
      if (!email) throw new Error("Access identity has no email claim");
      return { email };
    } catch {
      throw new ApiError(403, "ADMIN_REQUIRED", false, "Administrator access is required.");
    }
  },
  async sendModerationEmail(env, message): Promise<void> {
    const supportEmail = env.SUPPORT_EMAIL?.trim() || "support@aliahad.com";
    const stateLabel = message.state === "active" ? "restored" : message.state;
    const until = message.effectiveUntil
      ? `<p><strong>Effective until:</strong> ${escapeHtml(new Date(message.effectiveUntil).toISOString())}</p>`
      : "";
    await env.EMAIL.send({
      from: { email: "login@wovoice.aliahad.com", name: "WoVoice Accounts" },
      to: message.to,
      replyTo: supportEmail,
      subject: `Your WoVoice account access was ${stateLabel}`,
      text: [
        `Your WoVoice account access was ${stateLabel}.`,
        message.effectiveUntil ? `Effective until: ${new Date(message.effectiveUntil).toISOString()}` : "",
        message.publicMessage,
        `Questions or appeals: ${supportEmail}`,
      ].filter(Boolean).join("\n\n"),
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:28px;color:#17171a"><h1 style="font-size:24px">WoVoice account update</h1><p>Your WoVoice account access was <strong>${escapeHtml(stateLabel)}</strong>.</p>${until}<p>${escapeHtml(message.publicMessage)}</p><p>Questions or appeals: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p></div>`,
    });
  },
};

export async function handleAdminRoute(
  request: Request,
  env: AppEnv,
  requestId: string,
  services: AdminServices = productionAdminServices,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;

  const admin = await authenticateAdmin(request, env, services);
  if (!url.pathname.startsWith("/admin/api/v1")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "INVALID_REQUEST", false, "This admin resource is read-only.");
    }
    return adminAsset(request, env);
  }

  if (!["GET", "HEAD"].includes(request.method)) requireSameOrigin(request, env);
  const apiPath = url.pathname.slice("/admin/api/v1".length) || "/";

  if (request.method === "GET" && apiPath === "/session") {
    return noStoreJson({ requestId, admin: { id: admin.userId, email: admin.email, role: admin.role } });
  }
  if (request.method === "GET" && apiPath === "/overview") {
    return overview(env, requestId, url.searchParams.get("period") ?? "7d");
  }
  if (request.method === "GET" && apiPath === "/users") {
    return listUsers(env, requestId, url.searchParams);
  }
  if (request.method === "GET" && apiPath === "/audit") {
    return listAudit(env, requestId, url.searchParams);
  }

  const activityMatch = apiPath.match(/^\/users\/([^/]+)\/activity$/u);
  if (request.method === "GET" && activityMatch) {
    return userActivity(env, requestId, decodeURIComponent(activityMatch[1]), url.searchParams);
  }
  const detailMatch = apiPath.match(/^\/users\/([^/]+)$/u);
  if (request.method === "GET" && detailMatch) {
    return userDetail(env, requestId, decodeURIComponent(detailMatch[1]));
  }
  const statusMatch = apiPath.match(/^\/users\/([^/]+)\/status$/u);
  if (request.method === "POST" && statusMatch) {
    return updateStatus(request, env, requestId, admin, decodeURIComponent(statusMatch[1]), services, ctx);
  }
  const sessionsMatch = apiPath.match(/^\/users\/([^/]+)\/sessions\/revoke$/u);
  if (request.method === "POST" && sessionsMatch) {
    return revokeSessions(request, env, requestId, admin, decodeURIComponent(sessionsMatch[1]));
  }
  const quotaMatch = apiPath.match(/^\/users\/([^/]+)\/quota-override$/u);
  if (request.method === "PUT" && quotaMatch) {
    return setQuotaOverride(request, env, requestId, admin, decodeURIComponent(quotaMatch[1]));
  }
  const clearQuotaMatch = apiPath.match(/^\/users\/([^/]+)\/quota-override\/clear$/u);
  if (request.method === "POST" && clearQuotaMatch) {
    return clearQuotaOverride(request, env, requestId, admin, decodeURIComponent(clearQuotaMatch[1]));
  }
  const retryMatch = apiPath.match(/^\/notifications\/([^/]+)\/retry$/u);
  if (request.method === "POST" && retryMatch) {
    return retryNotification(request, env, requestId, admin, decodeURIComponent(retryMatch[1]), services, ctx);
  }
  throw new ApiError(404, "NOT_FOUND", false, "This admin endpoint does not exist.");
}

async function authenticateAdmin(request: Request, env: AppEnv, services: AdminServices): Promise<AdminPrincipal> {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim() ?? "";
  if (!assertion) throw new ApiError(403, "ADMIN_REQUIRED", false, "Administrator access is required.");
  const identity = await services.verifyAccessJwt(env, assertion);
  const lookup = await hmac(env.AUTH_MASTER_KEY, `email:${normalizeEmail(identity.email)}`);
  const user = await env.DB.prepare(
    "SELECT id, role, status FROM users WHERE email_lookup = ?",
  ).bind(lookup).first<{ id: string; role: AccountRole; status: AccountState }>();
  if (!user || user.role !== "admin" || user.status !== "active") {
    throw new ApiError(403, "ADMIN_REQUIRED", false, "Administrator access is required.");
  }
  return { userId: user.id, email: normalizeEmail(identity.email), role: "admin" };
}

async function adminAsset(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin") url.pathname = "/admin/";
  if (url.pathname === "/admin/") url.pathname = "/admin/index.html";
  const assetRequest = new Request(url, request);
  const asset = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(ADMIN_ASSET_HEADERS)) headers.set(name, value);
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

async function overview(env: AppEnv, requestId: string, period: string): Promise<Response> {
  const { startMs, startDate, normalized } = periodStart(period);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const [users, aggregate, global, email, latency] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
              SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
              SUM(CASE WHEN last_activity_at >= ? THEN 1 ELSE 0 END) AS active
       FROM users`,
    ).bind(startMs).first<{ total: number; suspended: number; banned: number; active: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(registered_users), 0) AS registeredUsers,
              COALESCE(SUM(login_successes), 0) AS loginSuccesses,
              COALESCE(SUM(transcriptions_succeeded), 0) AS succeeded,
              COALESCE(SUM(transcriptions_failed), 0) AS failed,
              COALESCE(SUM(audio_seconds), 0) AS audioSeconds,
              COALESCE(SUM(estimated_neurons), 0) AS estimatedNeurons,
              COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd,
              COALESCE(SUM(sync_operations), 0) AS syncOperations,
              COALESCE(SUM(quota_rejections), 0) AS quotaRejections
       FROM service_daily_aggregates WHERE date_key >= ?`,
    ).bind(startDate).first<Record<string, number>>(),
    env.DB.prepare(
      "SELECT used_neurons, reserved_neurons FROM global_daily_usage WHERE date_key = ?",
    ).bind(today).first<{ used_neurons: number; reserved_neurons: number }>(),
    env.DB.prepare(
      "SELECT verification_emails, moderation_emails FROM service_monthly_usage WHERE month_key = ?",
    ).bind(month).first<{ verification_emails: number; moderation_emails: number }>(),
    medianLatency(env, startMs),
  ]);
  const succeeded = aggregate?.succeeded ?? 0;
  const failed = aggregate?.failed ?? 0;
  return noStoreJson({
    requestId,
    period: normalized,
    users: {
      registered: users?.total ?? 0,
      active: users?.active ?? 0,
      suspended: users?.suspended ?? 0,
      banned: users?.banned ?? 0,
      newInPeriod: aggregate?.registeredUsers ?? 0,
    },
    transcription: {
      succeeded,
      failed,
      successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
      audioSeconds: aggregate?.audioSeconds ?? 0,
      medianLatencyMs: latency,
      quotaRejections: aggregate?.quotaRejections ?? 0,
    },
    usage: {
      estimated: true,
      neurons: aggregate?.estimatedNeurons ?? 0,
      estimatedCostUsd: aggregate?.estimatedCostUsd ?? 0,
      todayGlobalUsedNeurons: global?.used_neurons ?? 0,
      todayGlobalReservedNeurons: global?.reserved_neurons ?? 0,
      todayGlobalLimitNeurons: 8_000,
    },
    service: {
      loginSuccesses: aggregate?.loginSuccesses ?? 0,
      syncOperations: aggregate?.syncOperations ?? 0,
      verificationEmailsThisMonth: email?.verification_emails ?? 0,
      moderationEmailsThisMonth: email?.moderation_emails ?? 0,
      monthlyEmailLimit: 2_500,
    },
  });
}

async function listUsers(env: AppEnv, requestId: string, params: URLSearchParams): Promise<Response> {
  const limit = pageLimit(params.get("limit"));
  const status = params.get("status")?.trim() ?? "";
  if (status && !["active", "suspended", "banned"].includes(status)) {
    throw new ApiError(400, "INVALID_REQUEST", false, "The user status filter is invalid.");
  }
  const cursor = parseCursor(params.get("cursor"));
  const query = params.get("query")?.trim() ?? "";
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (status) {
    conditions.push("u.status = ?");
    bindings.push(status);
  }
  if (query) {
    if (query.includes("@")) {
      const normalizedEmail = normalizeEmail(query);
      if (!normalizedEmail) {
        throw new ApiError(400, "INVALID_REQUEST", false, "Enter a complete email address.");
      }
      conditions.push("u.email_lookup = ?");
      bindings.push(await hmac(env.AUTH_MASTER_KEY, `email:${normalizedEmail}`));
    } else {
      if (!/^[A-Za-z0-9._~-]{1,100}$/u.test(query)) {
        throw new ApiError(400, "INVALID_REQUEST", false, "Enter a complete user ID.");
      }
      conditions.push("u.id = ?");
      bindings.push(query);
    }
  }
  if (cursor) {
    conditions.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const today = new Date().toISOString().slice(0, 10);
  const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    `SELECT u.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
              AND s.absolute_expires_at > ?) AS session_count,
            (SELECT COALESCE(used_audio_seconds, 0) FROM daily_usage d
              WHERE d.user_id = u.id AND d.date_key = ?) AS today_audio_seconds,
            (SELECT COALESCE(SUM(used_audio_seconds), 0) FROM daily_usage d
              WHERE d.user_id = u.id AND d.date_key >= ?) AS used_audio_seconds_90d,
            (SELECT COALESCE(SUM(request_count), 0) FROM daily_usage d
              WHERE d.user_id = u.id AND d.date_key >= ?) AS request_count_90d
     FROM users u ${where}
     ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
  ).bind(Date.now(), today, cutoff90, cutoff90, ...bindings, limit + 1).all<AdminUserRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const values = await Promise.all(rows.map((row) => adminUserSummary(env, row)));
  const last = rows.at(-1);
  return noStoreJson({
    requestId,
    users: values,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  });
}

async function userDetail(env: AppEnv, requestId: string, userId: string): Promise<Response> {
  const user = await getUser(env, userId);
  const today = new Date().toISOString().slice(0, 10);
  const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const [usage, sessions, syncCounts, notifications] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(used_audio_seconds), 0) AS audioSeconds,
              COALESCE(SUM(used_neurons), 0) AS neurons,
              COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(CASE WHEN date_key = ? THEN used_audio_seconds ELSE 0 END), 0) AS todayAudioSeconds
       FROM daily_usage WHERE user_id = ? AND date_key >= ?`,
    ).bind(today, userId, cutoff90).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT id, device_name AS deviceName, created_at AS createdAt, last_seen_at AS lastSeenAt,
              revoked_at AS revokedAt, absolute_expires_at AS absoluteExpiresAt
       FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 25`,
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT item_type AS type, COUNT(*) AS count,
              COALESCE(SUM(LENGTH(ciphertext)), 0) AS encryptedBytes
       FROM sync_items WHERE user_id = ? GROUP BY item_type`,
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT id, action, public_message AS publicMessage, effective_until AS effectiveUntil,
              status, attempts, last_error AS lastError, created_at AS createdAt, sent_at AS sentAt
       FROM moderation_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    ).bind(userId).all(),
  ]);
  const email = await decryptString(env.PII_KEY, user.email_ciphertext, user.email_nonce);
  return noStoreJson({
    requestId,
    user: {
      id: user.id,
      email,
      role: user.role,
      status: accountStatusValue(user),
      createdAt: user.created_at,
      verifiedAt: user.verified_at,
      lastActivityAt: user.last_activity_at,
      termsVersion: user.terms_version,
      quota: {
        limitAudioSeconds: effectiveDailyAudioLimit(user),
        overrideLimitAudioSeconds: user.quota_limit_audio_seconds,
        overrideExpiresAt: user.quota_override_expires_at,
        todayUsedAudioSeconds: usage?.todayAudioSeconds ?? 0,
      },
      usage90d: {
        audioSeconds: usage?.audioSeconds ?? 0,
        neurons: usage?.neurons ?? 0,
        requests: usage?.requests ?? 0,
      },
      sessions: sessions.results,
      encryptedSyncMetadata: syncCounts.results,
      notifications: notifications.results,
    },
  });
}

async function userActivity(env: AppEnv, requestId: string, userId: string, params: URLSearchParams): Promise<Response> {
  await getUser(env, userId);
  const limit = pageLimit(params.get("limit"));
  const cursor = parseCursor(params.get("cursor"));
  const result = await env.DB.prepare(
    `SELECT id, event_type AS type, request_id AS requestId, status_code AS statusCode,
            outcome_code AS outcomeCode, model, audio_seconds AS audioSeconds,
            estimated_neurons AS estimatedNeurons, estimated_cost_usd AS estimatedCostUsd,
            latency_ms AS latencyMs, item_count AS itemCount, device_name AS deviceName,
            created_at AS createdAt
     FROM user_activity_events WHERE user_id = ?
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(
    userId,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit + 1,
  ).all<Record<string, unknown> & { id: string; createdAt: number }>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return noStoreJson({
    requestId,
    activity: rows,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}

async function listAudit(env: AppEnv, requestId: string, params: URLSearchParams): Promise<Response> {
  const limit = pageLimit(params.get("limit"));
  const cursor = parseCursor(params.get("cursor"));
  const action = params.get("action")?.trim().slice(0, 80) ?? "";
  const result = await env.DB.prepare(
    `SELECT id, actor_user_id AS actorUserId, target_user_id AS targetUserId, action,
            internal_reason AS internalReason, before_state AS beforeState,
            after_state AS afterState, request_id AS requestId, created_at AS createdAt
     FROM admin_audit_events
     WHERE (? = '' OR action = ?)
       AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(
    action,
    action,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit + 1,
  ).all<{
    id: string;
    actorUserId: string | null;
    targetUserId: string | null;
    action: string;
    internalReason: string;
    beforeState: string | null;
    afterState: string | null;
    requestId: string;
    createdAt: number;
  }>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit).map((row) => ({
    ...row,
    beforeState: parseStoredJson(row.beforeState),
    afterState: parseStoredJson(row.afterState),
  }));
  const last = result.results.slice(0, limit).at(-1);
  return noStoreJson({
    requestId,
    audit: rows,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}

async function updateStatus(
  request: Request,
  env: AppEnv,
  requestId: string,
  admin: AdminPrincipal,
  userId: string,
  services: AdminServices,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJson<{
    status?: unknown;
    suspendedUntil?: unknown;
    publicMessage?: unknown;
    internalReason?: unknown;
  }>(request);
  const target = await mutableTarget(env, userId);
  const status = body.status;
  if (status !== "active" && status !== "suspended" && status !== "banned") {
    throw new ApiError(400, "INVALID_STATUS_TRANSITION", false, "Choose active, suspended, or banned.");
  }
  if (target.status === status && !(status === "suspended" && target.suspended_until !== body.suspendedUntil)) {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", false, "The account already has that status.");
  }
  const now = Date.now();
  let suspendedUntil: number | null = null;
  if (status === "suspended") {
    suspendedUntil = finiteTimestamp(body.suspendedUntil);
    if (suspendedUntil <= now || suspendedUntil > now + MAX_SUSPENSION_MS) {
      throw new ApiError(400, "INVALID_STATUS_TRANSITION", false, "Suspensions must end within the next 180 days.");
    }
  }
  const internalReason = requiredText(body.internalReason, 5, 500, "Enter an internal reason.");
  const publicMessage = publicStatusMessage(status, body.publicMessage);
  const action = status === "active" ? "user_restored" : status === "suspended" ? "user_suspended" : "user_banned";
  const before = { status: target.status, suspendedUntil: target.suspended_until, publicMessage: target.public_status_message };
  const after = { status, suspendedUntil, publicMessage: status === "active" ? null : publicMessage };
  const notificationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET status = ?, suspended_until = ?, public_status_message = ?, status_changed_at = ?
       WHERE id = ? AND role != 'admin'`,
    ).bind(status, suspendedUntil, status === "active" ? null : publicMessage, now, userId),
    env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, userId),
    env.DB.prepare(
      `INSERT INTO admin_audit_events
        (id, actor_user_id, target_user_id, action, internal_reason, before_state, after_state, request_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), admin.userId, userId, action, internalReason,
      JSON.stringify(before), JSON.stringify(after), requestId, now,
    ),
    env.DB.prepare(
      `INSERT INTO moderation_notifications
        (id, user_id, action, public_message, effective_until, status, attempts,
         next_attempt_at, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).bind(notificationId, userId, status, publicMessage, suspendedUntil, now, now, now),
  ]);
  await defer(ctx, processModerationNotifications(env, services, 1));
  await defer(ctx, recordActivity(env, {
    userId,
    type: status === "active" ? "account_restored" : "account_restricted",
    requestId,
    statusCode: 200,
  }));
  return noStoreJson({ requestId, userId, status: after, notificationId });
}

async function revokeSessions(
  request: Request,
  env: AppEnv,
  requestId: string,
  admin: AdminPrincipal,
  userId: string,
): Promise<Response> {
  const body = await readJson<{ scope?: unknown; sessionId?: unknown; internalReason?: unknown }>(request);
  await mutableTarget(env, userId);
  const scope = body.scope === "one" ? "one" : body.scope === "all" ? "all" : "";
  if (!scope) throw new ApiError(400, "INVALID_REQUEST", false, "Choose one session or all sessions.");
  const reason = requiredText(body.internalReason, 5, 500, "Enter an internal reason.");
  const sessionId = scope === "one" && typeof body.sessionId === "string" ? body.sessionId.slice(0, 100) : null;
  if (scope === "one" && !sessionId) throw new ApiError(400, "INVALID_REQUEST", false, "Choose a device session.");
  const now = Date.now();
  const update = scope === "all"
    ? env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, userId)
    : env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL")
      .bind(now, userId, sessionId);
  const results = await env.DB.batch([
    update,
    env.DB.prepare(
      `INSERT INTO admin_audit_events
        (id, actor_user_id, target_user_id, action, internal_reason, before_state, after_state, request_id, created_at)
       VALUES(?, ?, ?, 'sessions_revoked', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), admin.userId, userId, reason,
      JSON.stringify({ scope, sessionId }), JSON.stringify({ revokedAt: now }), requestId, now,
    ),
  ]);
  await recordActivity(env, { userId, type: "session_revoked", requestId, statusCode: 200 });
  return noStoreJson({ requestId, revoked: results[0]?.meta.changes ?? 0 });
}

async function setQuotaOverride(
  request: Request,
  env: AppEnv,
  requestId: string,
  admin: AdminPrincipal,
  userId: string,
): Promise<Response> {
  const body = await readJson<{ limitAudioSeconds?: unknown; expiresAt?: unknown; internalReason?: unknown }>(request);
  const target = await mutableTarget(env, userId);
  const limit = typeof body.limitAudioSeconds === "number" ? body.limitAudioSeconds : Number.NaN;
  const expiresAt = finiteTimestamp(body.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(limit) || limit < 600 || limit > 3_600) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Daily quota grants must be between 600 and 3,600 seconds.");
  }
  if (expiresAt <= now || expiresAt > now + MAX_QUOTA_OVERRIDE_MS) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Quota grants must expire within 30 days.");
  }
  const reason = requiredText(body.internalReason, 5, 500, "Enter an internal reason.");
  const before = { limitAudioSeconds: target.quota_limit_audio_seconds, expiresAt: target.quota_override_expires_at };
  const after = { limitAudioSeconds: limit, expiresAt };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET quota_limit_audio_seconds = ?, quota_override_expires_at = ? WHERE id = ? AND role != 'admin'",
    ).bind(limit, expiresAt, userId),
    auditStatement(env, admin.userId, userId, "quota_override_set", reason, before, after, requestId, now),
  ]);
  return noStoreJson({ requestId, userId, quotaOverride: after });
}

async function clearQuotaOverride(
  request: Request,
  env: AppEnv,
  requestId: string,
  admin: AdminPrincipal,
  userId: string,
): Promise<Response> {
  const body = await readJson<{ internalReason?: unknown }>(request);
  const target = await mutableTarget(env, userId);
  const reason = requiredText(body.internalReason, 5, 500, "Enter an internal reason.");
  const before = { limitAudioSeconds: target.quota_limit_audio_seconds, expiresAt: target.quota_override_expires_at };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET quota_limit_audio_seconds = NULL, quota_override_expires_at = NULL WHERE id = ? AND role != 'admin'",
    ).bind(userId),
    auditStatement(env, admin.userId, userId, "quota_override_cleared", reason, before, null, requestId, now),
  ]);
  return noStoreJson({ requestId, userId, quotaOverride: null });
}

async function retryNotification(
  request: Request,
  env: AppEnv,
  requestId: string,
  admin: AdminPrincipal,
  notificationId: string,
  services: AdminServices,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJson<{ internalReason?: unknown }>(request);
  const reason = requiredText(body.internalReason, 5, 500, "Enter an internal reason.");
  const row = await env.DB.prepare(
    "SELECT id, user_id, status FROM moderation_notifications WHERE id = ?",
  ).bind(notificationId).first<{ id: string; user_id: string; status: string }>();
  if (!row) throw new ApiError(404, "NOT_FOUND", false, "The notification does not exist.");
  if (row.status !== "failed") throw new ApiError(409, "INVALID_REQUEST", false, "Only failed notices can be retried.");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE moderation_notifications SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
    ).bind(now, now, notificationId),
    auditStatement(
      env, admin.userId, row.user_id, "moderation_notice_retried", reason,
      { notificationId, status: "failed" }, { notificationId, status: "pending" }, requestId, now,
    ),
  ]);
  await defer(ctx, processModerationNotifications(env, services, 1));
  return noStoreJson({ requestId, notificationId, status: "pending" });
}

async function getUser(env: AppEnv, userId: string): Promise<AdminUserRow> {
  if (!/^[A-Za-z0-9._~-]{1,100}$/u.test(userId)) {
    throw new ApiError(404, "NOT_FOUND", false, "The user does not exist.");
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId).first<AdminUserRow>();
  if (!user) throw new ApiError(404, "NOT_FOUND", false, "The user does not exist.");
  return user;
}

async function mutableTarget(env: AppEnv, userId: string): Promise<AdminUserRow> {
  const user = await getUser(env, userId);
  if (user.role === "admin") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", false, "The sole administrator cannot be modified here.");
  }
  return user;
}

async function adminUserSummary(env: AppEnv, user: AdminUserRow): Promise<object> {
  const email = await decryptString(env.PII_KEY, user.email_ciphertext, user.email_nonce);
  return {
    id: user.id,
    email: maskEmail(email),
    role: user.role,
    status: accountStatusValue(user),
    createdAt: user.created_at,
    lastActivityAt: user.last_activity_at,
    sessionCount: user.session_count ?? 0,
    todayAudioSeconds: user.today_audio_seconds ?? 0,
    usage90d: {
      audioSeconds: user.used_audio_seconds_90d ?? 0,
      requests: user.request_count_90d ?? 0,
    },
    quotaLimitAudioSeconds: effectiveDailyAudioLimit(user),
  };
}

function auditStatement(
  env: AppEnv,
  actorUserId: string,
  targetUserId: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
  requestId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_audit_events
      (id, actor_user_id, target_user_id, action, internal_reason, before_state, after_state, request_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), actorUserId, targetUserId, action, reason,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    requestId, now,
  );
}

async function medianLatency(env: AppEnv, startMs: number): Promise<number | null> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM user_activity_events WHERE latency_ms IS NOT NULL AND created_at >= ?",
  ).bind(startMs).first<{ count: number }>();
  const total = count?.count ?? 0;
  if (total === 0) return null;
  const offset = Math.floor((total - 1) / 2);
  const values = await env.DB.prepare(
    "SELECT latency_ms FROM user_activity_events WHERE latency_ms IS NOT NULL AND created_at >= ? ORDER BY latency_ms LIMIT ? OFFSET ?",
  ).bind(startMs, total % 2 === 0 ? 2 : 1, offset).all<{ latency_ms: number }>();
  if (!values.results.length) return null;
  return Math.round(values.results.reduce((sum, value) => sum + value.latency_ms, 0) / values.results.length);
}

function requireSameOrigin(request: Request, env: AppEnv): void {
  if (request.headers.get("origin") !== env.APP_ORIGIN) {
    throw new ApiError(403, "ADMIN_REQUIRED", false, "The admin request origin is invalid.");
  }
}

function periodStart(value: string): { startMs: number; startDate: string; normalized: string } {
  const normalized = ["today", "7d", "30d", "90d", "12m"].includes(value) ? value : "7d";
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = normalized === "today" ? 0 : normalized === "7d" ? 6 : normalized === "30d" ? 29 : normalized === "90d" ? 89 : 364;
  const startMs = today - days * 86_400_000;
  return { startMs, startDate: new Date(startMs).toISOString().slice(0, 10), normalized };
}

function publicStatusMessage(status: AccountState, value: unknown): string {
  if (status === "active") return "Your WoVoice account access has been restored.";
  const supplied = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim() : "";
  if (supplied.length > 240) throw new ApiError(400, "INVALID_REQUEST", false, "The public message is too long.");
  if (supplied) return supplied;
  return status === "suspended"
    ? "Your WoVoice cloud access is temporarily suspended. Contact support if you believe this is a mistake."
    : "Your WoVoice cloud access has been disabled. Contact support if you believe this is a mistake.";
}

function requiredText(value: unknown, min: number, max: number, message: string): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim() : "";
  if (text.length < min || text.length > max) throw new ApiError(400, "INVALID_REQUEST", false, message);
  return text;
}

function finiteTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function pageLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  return Number.isFinite(parsed) ? Math.min(MAX_PAGE_SIZE, Math.max(1, parsed)) : 50;
}

function encodeCursor(createdAt: number, id: string): string {
  return base64Url(new TextEncoder().encode(JSON.stringify({ createdAt, id })));
}

function parseCursor(value: string | null): { createdAt: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)) throw new Error("bad cursor");
    if (typeof parsed.id !== "string" || !/^[A-Za-z0-9._~-]{1,100}$/u.test(parsed.id)) throw new Error("bad cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", false, "The pagination cursor is invalid.");
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return "";
  return email;
}

function normalizedTeamDomain(value: string | undefined): string {
  const raw = value?.trim().replace(/\/+$/u, "") ?? "";
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.pathname === "/" ? url.origin : "";
  } catch {
    return "";
  }
}

function parseStoredJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function defer(ctx: ExecutionContext | undefined, promise: Promise<unknown>): Promise<void> {
  if (ctx) {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
