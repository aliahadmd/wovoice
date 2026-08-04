import { ApiError } from "./errors";
import { decryptString, encryptString, hmac, randomCode, randomToken, sha256, timingSafeEqual } from "./crypto";
import { noStoreJson, readJson } from "./http";
import type { AppEnv, AuthServices, Principal } from "./types";

const CODE_LIFETIME_MS = 10 * 60_000;
const CODE_RESEND_MS = 60_000;
const AUTHORIZATION_CODE_MS = 60_000;
const ACCESS_TOKEN_MS = 15 * 60_000;
const REFRESH_TOKEN_MS = 30 * 24 * 60 * 60_000;
const SESSION_ABSOLUTE_MS = 180 * 24 * 60 * 60_000;
const POLICY_VERSION = "2026-08-05";

interface ChallengeRow {
  id: string;
  email_lookup: string;
  email_ciphertext: string;
  email_nonce: string;
  intent: "login" | "delete";
  code_hash: string;
  code_challenge: string;
  attempts: number;
  expires_at: number;
  resend_after: number;
  consumed_at: number | null;
}

interface UserRow {
  id: string;
  email_ciphertext: string;
  email_nonce: string;
  wrapped_vault_key: string | null;
  wrapped_vault_nonce: string | null;
  vault_key_version: number | null;
}

interface AuthorizationCodeRow {
  id: string;
  user_id: string;
  kind: "login" | "delete";
  code_challenge: string;
  expires_at: number;
  used_at: number | null;
  challenge_id: string | null;
}

interface AccessRow {
  session_id: string;
  user_id: string;
  access_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}

interface RefreshRow {
  refresh_id: string;
  session_id: string;
  user_id: string;
  refresh_expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  absolute_expires_at: number;
}

export const productionAuthServices: AuthServices = {
  async verifyTurnstile(env, token, remoteIp, idempotencyKey): Promise<boolean> {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
      idempotency_key: idempotencyKey,
    });
    if (remoteIp) body.set("remoteip", remoteIp);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  },
  async sendCode(env, email, code): Promise<void> {
    await env.EMAIL.send({
      from: { email: "login@wovoice.aliahad.com", name: "WoVoice" },
      to: email,
      subject: `${code} is your WoVoice verification code`,
      text: `Your WoVoice verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:28px;color:#17171a"><h1 style="font-size:24px">Verify your WoVoice account</h1><p>Enter this code in the secure WoVoice sign-in page:</p><p style="font-size:34px;font-weight:750;letter-spacing:8px;margin:28px 0">${code}</p><p style="color:#666">The code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`,
    });
  },
};

export async function handleAuthRoute(
  request: Request,
  env: AppEnv,
  services: AuthServices,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/auth/config") {
    return noStoreJson({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, policyVersion: POLICY_VERSION });
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/start") {
    return startAuthentication(request, env, services, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/verify") {
    return verifyCode(request, env, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/token") {
    return exchangeCode(request, env, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/refresh") {
    return refreshSession(request, env, requestId);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
    const principal = await authenticateAccess(request, env);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), principal.sessionId, principal.userId)
      .run();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

async function startAuthentication(
  request: Request,
  env: AppEnv,
  services: AuthServices,
  requestId: string,
): Promise<Response> {
  const body = await readJson<{
    email?: unknown;
    turnstileToken?: unknown;
    codeChallenge?: unknown;
    intent?: unknown;
    termsAccepted?: unknown;
  }>(request);
  const email = normalizeEmail(body.email);
  const codeChallenge = validateCodeChallenge(body.codeChallenge);
  const intent = body.intent === "delete" ? "delete" : "login";
  if (intent === "login" && body.termsAccepted !== true) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Accept the Terms and Privacy Policy to continue.");
  }
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  if (!turnstileToken || turnstileToken.length > 2_048) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Complete the security check and try again.");
  }
  const emailLookup = await hmac(env.AUTH_MASTER_KEY, `email:${email}`);
  const burst = await env.AUTH_RATE_LIMITER.limit({ key: emailLookup });
  if (!burst.success) {
    throw new ApiError(429, "EMAIL_RATE_LIMITED", true, "Please wait before requesting another code.", 60);
  }
  const validTurnstile = await services.verifyTurnstile(
    env,
    turnstileToken,
    request.headers.get("cf-connecting-ip"),
    requestId,
  );
  if (!validTurnstile) {
    throw new ApiError(400, "INVALID_REQUEST", false, "The security check expired. Please try again.");
  }
  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT resend_after FROM login_challenges WHERE email_lookup = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(emailLookup).first<{ resend_after: number }>();
  if (recent && recent.resend_after > now) {
    const retryAfter = Math.max(1, Math.ceil((recent.resend_after - now) / 1_000));
    throw new ApiError(429, "EMAIL_RATE_LIMITED", true, "Please wait before requesting another code.", retryAfter);
  }

  const monthKey = new Date(now).toISOString().slice(0, 7);
  let monthly: D1Result[];
  try {
    monthly = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO service_monthly_usage(month_key, verification_emails) VALUES(?, 0)").bind(monthKey),
      env.DB.prepare("UPDATE service_monthly_usage SET verification_emails = verification_emails + 1 WHERE month_key = ?").bind(monthKey),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("EMAIL_RATE_LIMITED")) {
      throw new ApiError(503, "EMAIL_RATE_LIMITED", true, "WoVoice has reached its monthly verification limit.", 3_600);
    }
    throw error;
  }
  if ((monthly[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(503, "EMAIL_RATE_LIMITED", true, "WoVoice has reached its monthly verification limit.", 3_600);
  }

  const challengeId = crypto.randomUUID();
  const code = randomCode();
  const encrypted = await encryptString(env.PII_KEY, email);
  const codeHash = await hmac(env.AUTH_MASTER_KEY, `otp:${challengeId}:${code}`);
  await env.DB.prepare(
    `INSERT INTO login_challenges
      (id, email_lookup, email_ciphertext, email_nonce, intent, code_hash, code_challenge,
       attempts, created_at, expires_at, resend_after)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).bind(
    challengeId,
    emailLookup,
    encrypted.ciphertext,
    encrypted.nonce,
    intent,
    codeHash,
    codeChallenge,
    now,
    now + CODE_LIFETIME_MS,
    now + CODE_RESEND_MS,
  ).run();
  try {
    await services.sendCode(env, email, code);
  } catch (error) {
    console.error(JSON.stringify({
      event: "verification_email_failed",
      requestId,
      reason: safeInfrastructureError(error),
    }));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_challenges WHERE id = ?").bind(challengeId),
      env.DB.prepare(
        "UPDATE service_monthly_usage SET verification_emails = MAX(0, verification_emails - 1) WHERE month_key = ?",
      ).bind(monthKey),
    ]);
    throw new ApiError(503, "EMAIL_SEND_FAILED", true, "The verification email could not be sent. Please try again.");
  }
  return noStoreJson({ requestId, challengeId, expiresIn: 600, resendAfter: 60 });
}

async function verifyCode(request: Request, env: AppEnv, requestId: string): Promise<Response> {
  const body = await readJson<{ challengeId?: unknown; code?: unknown }>(request);
  const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!challengeId || !/^\d{6}$/u.test(code)) invalidCode();
  const challenge = await env.DB.prepare("SELECT * FROM login_challenges WHERE id = ?")
    .bind(challengeId)
    .first<ChallengeRow>();
  const now = Date.now();
  if (!challenge || challenge.consumed_at !== null || challenge.expires_at < now || challenge.attempts >= 5) invalidCode();
  const candidateHash = await hmac(env.AUTH_MASTER_KEY, `otp:${challenge.id}:${code}`);
  if (!timingSafeEqual(candidateHash, challenge.code_hash)) {
    await env.DB.prepare("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?").bind(challenge.id).run();
    invalidCode();
  }

  let user = await env.DB.prepare("SELECT * FROM users WHERE email_lookup = ?")
    .bind(challenge.email_lookup)
    .first<UserRow>();
  if (!user && challenge.intent === "delete") invalidCode();
  if (!user) {
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO users
          (id, email_lookup, email_ciphertext, email_nonce, created_at, verified_at, terms_version)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        challenge.email_lookup,
        challenge.email_ciphertext,
        challenge.email_nonce,
        now,
        now,
        POLICY_VERSION,
      ).run();
    } catch {
      // Another verification for the same address may have won the uniqueness race.
    }
    user = await env.DB.prepare("SELECT * FROM users WHERE email_lookup = ?")
      .bind(challenge.email_lookup)
      .first<UserRow>();
  }
  if (!user) throw new ApiError(500, "AUTH_REQUIRED", true, "The account could not be created. Please try again.");
  const rawAuthorizationCode = randomToken();
  const authorizationCodeHash = await hmac(env.AUTH_MASTER_KEY, `authorization:${rawAuthorizationCode}`);
  const authorizationCodeId = crypto.randomUUID();
  const verificationStatements = [
    env.DB.prepare("UPDATE login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .bind(now, challenge.id),
    env.DB.prepare(
      `INSERT INTO authorization_codes
        (id, token_hash, user_id, kind, code_challenge, created_at, expires_at, challenge_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      authorizationCodeId,
      authorizationCodeHash,
      user.id,
      challenge.intent,
      challenge.code_challenge,
      now,
      now + AUTHORIZATION_CODE_MS,
      challenge.id,
    ),
  ];
  if (challenge.intent === "login") {
    verificationStatements.push(
      env.DB.prepare("UPDATE users SET terms_version = ? WHERE id = ?").bind(POLICY_VERSION, user.id),
    );
  }
  try {
    await env.DB.batch(verificationStatements);
  } catch {
    invalidCode();
  }
  return noStoreJson(
    challenge.intent === "delete"
      ? { requestId, reauthToken: rawAuthorizationCode, expiresIn: 60 }
      : { requestId, authorizationCode: rawAuthorizationCode, expiresIn: 60 },
  );
}

async function exchangeCode(request: Request, env: AppEnv, requestId: string): Promise<Response> {
  const body = await readJson<{
    grantType?: unknown;
    code?: unknown;
    codeVerifier?: unknown;
    deviceName?: unknown;
  }>(request);
  if (body.grantType !== "authorization_code") {
    throw new ApiError(400, "INVALID_REQUEST", false, "The authorization grant is invalid.");
  }
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
  const deviceName = sanitizeDeviceName(body.deviceName);
  if (!code || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
    throw new ApiError(400, "INVALID_REQUEST", false, "The authorization grant is invalid.");
  }
  const codeHash = await hmac(env.AUTH_MASTER_KEY, `authorization:${code}`);
  const row = await env.DB.prepare("SELECT * FROM authorization_codes WHERE token_hash = ?")
    .bind(codeHash)
    .first<AuthorizationCodeRow>();
  const now = Date.now();
  if (!row || row.kind !== "login" || row.used_at !== null || row.expires_at < now) {
    throw new ApiError(401, "AUTH_REQUIRED", false, "The sign-in request expired. Please start again.");
  }
  const calculatedChallenge = await sha256(verifier);
  if (!timingSafeEqual(calculatedChallenge, row.code_challenge)) {
    throw new ApiError(401, "AUTH_REQUIRED", false, "The sign-in request could not be verified.");
  }
  let tokens: SessionTokens;
  try {
    tokens = await createSession(env, row.user_id, deviceName, now, row.id);
  } catch {
    throw new ApiError(401, "AUTH_REQUIRED", false, "The sign-in request was already used. Please start again.");
  }
  return noStoreJson({ requestId, ...tokens, user: await publicUser(env, row.user_id) });
}

async function createSession(
  env: AppEnv,
  userId: string,
  deviceName: string,
  now: number,
  authorizationCodeId: string,
): Promise<SessionTokens> {
  const sessionId = crypto.randomUUID();
  const refreshId = crypto.randomUUID();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const [accessHash, refreshHash] = await Promise.all([
    hmac(env.AUTH_MASTER_KEY, `access:${accessToken}`),
    hmac(env.AUTH_MASTER_KEY, `refresh:${refreshToken}`),
  ]);
  await env.DB.batch([
    env.DB.prepare("UPDATE authorization_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, authorizationCodeId),
    env.DB.prepare(
      `INSERT INTO sessions
        (id, authorization_code_id, user_id, device_name, access_hash, access_expires_at, absolute_expires_at,
         created_at, last_seen_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, authorizationCodeId, userId, deviceName, accessHash, now + ACCESS_TOKEN_MS, now + SESSION_ABSOLUTE_MS, now, now),
    env.DB.prepare(
      `INSERT INTO refresh_tokens(id, session_id, token_hash, created_at, expires_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).bind(refreshId, sessionId, refreshHash, now, now + REFRESH_TOKEN_MS),
  ]);
  return { accessToken, accessExpiresIn: 900, refreshToken, refreshExpiresIn: 2_592_000 };
}

async function refreshSession(request: Request, env: AppEnv, requestId: string): Promise<Response> {
  const body = await readJson<{ refreshToken?: unknown }>(request);
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (!refreshToken) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  const refreshHash = await hmac(env.AUTH_MASTER_KEY, `refresh:${refreshToken}`);
  const row = await env.DB.prepare(
    `SELECT r.id AS refresh_id, r.session_id, s.user_id, r.expires_at AS refresh_expires_at,
            r.used_at, s.revoked_at, s.absolute_expires_at
     FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id
     WHERE r.token_hash = ?`,
  ).bind(refreshHash).first<RefreshRow>();
  const now = Date.now();
  if (!row) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  if (row.used_at !== null) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, row.session_id)
      .run();
    throw new ApiError(401, "AUTH_REQUIRED", false, "This session was revoked for security. Sign in again.");
  }
  if (row.revoked_at !== null || row.refresh_expires_at < now || row.absolute_expires_at < now) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .bind(now, row.session_id)
      .run();
    throw new ApiError(401, "AUTH_REQUIRED", false, "Your session expired. Sign in again.");
  }

  const accessToken = randomToken();
  const nextRefreshToken = randomToken();
  const nextRefreshId = crypto.randomUUID();
  const [accessHash, nextRefreshHash] = await Promise.all([
    hmac(env.AUTH_MASTER_KEY, `access:${accessToken}`),
    hmac(env.AUTH_MASTER_KEY, `refresh:${nextRefreshToken}`),
  ]);
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE refresh_tokens SET used_at = ?, replaced_by = ? WHERE id = ? AND used_at IS NULL")
        .bind(now, nextRefreshId, row.refresh_id),
      env.DB.prepare(
        `INSERT INTO refresh_tokens(id, session_id, token_hash, created_at, expires_at, parent_id)
         VALUES(?, ?, ?, ?, ?, ?)`,
      ).bind(nextRefreshId, row.session_id, nextRefreshHash, now, now + REFRESH_TOKEN_MS, row.refresh_id),
      env.DB.prepare(
        "UPDATE sessions SET access_hash = ?, access_expires_at = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).bind(accessHash, now + ACCESS_TOKEN_MS, now, row.session_id),
    ]);
  } catch {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, row.session_id)
      .run();
    throw new ApiError(401, "AUTH_REQUIRED", false, "This session was revoked for security. Sign in again.");
  }
  return noStoreJson({
    requestId,
    accessToken,
    accessExpiresIn: 900,
    refreshToken: nextRefreshToken,
    refreshExpiresIn: 2_592_000,
    user: await publicUser(env, row.user_id),
  });
}

export async function authenticateAccess(request: Request, env: AppEnv): Promise<Principal> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  const accessHash = await hmac(env.AUTH_MASTER_KEY, `access:${token}`);
  const row = await env.DB.prepare(
    `SELECT id AS session_id, user_id, access_expires_at, absolute_expires_at, revoked_at
     FROM sessions WHERE access_hash = ?`,
  ).bind(accessHash).first<AccessRow>();
  if (!row || row.revoked_at !== null || row.absolute_expires_at < Date.now()) {
    throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  }
  if (row.access_expires_at < Date.now()) {
    throw new ApiError(401, "TOKEN_EXPIRED", true, "Your session needs to be refreshed.");
  }
  return { userId: row.user_id, sessionId: row.session_id, legacy: false };
}

export async function handleAccountRoute(
  request: Request,
  env: AppEnv,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/me")) return null;
  const principal = await authenticateAccess(request, env);
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const user = await publicUser(env, principal.userId);
    const quota = await quotaSnapshot(env, principal.userId);
    return noStoreJson({ requestId, user, quota });
  }
  if (request.method === "GET" && url.pathname === "/v1/me/sessions") {
    const result = await env.DB.prepare(
      `SELECT id, device_name AS deviceName, created_at AS createdAt, last_seen_at AS lastSeenAt,
              CASE WHEN id = ? THEN 1 ELSE 0 END AS current
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND absolute_expires_at > ?
       ORDER BY last_seen_at DESC`,
    ).bind(principal.sessionId, principal.userId, Date.now()).all();
    return noStoreJson({ requestId, sessions: result.results });
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/v1/me/sessions/")) {
    const sessionId = decodeURIComponent(url.pathname.slice("/v1/me/sessions/".length));
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), sessionId, principal.userId)
      .run();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "DELETE" && url.pathname === "/v1/me") {
    const body = await readJson<{ reauthToken?: unknown }>(request);
    const token = typeof body.reauthToken === "string" ? body.reauthToken : "";
    const tokenHash = await hmac(env.AUTH_MASTER_KEY, `authorization:${token}`);
    const authorization = await env.DB.prepare(
      "SELECT * FROM authorization_codes WHERE token_hash = ? AND user_id = ?",
    ).bind(tokenHash, principal.userId).first<AuthorizationCodeRow>();
    if (!authorization || authorization.kind !== "delete" || authorization.used_at !== null || authorization.expires_at < Date.now()) {
      throw new ApiError(401, "AUTH_REQUIRED", false, "Verify your email again before deleting the account.");
    }
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(principal.userId).run();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

async function publicUser(env: AppEnv, userId: string): Promise<object> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!user) throw new ApiError(401, "AUTH_REQUIRED", false, "Sign in to continue.");
  const email = await decryptString(env.PII_KEY, user.email_ciphertext, user.email_nonce);
  return {
    id: user.id,
    email,
    vaultConfigured: user.wrapped_vault_key !== null,
    vaultKeyVersion: user.vault_key_version,
  };
}

async function quotaSnapshot(env: AppEnv, userId: string): Promise<object> {
  const dateKey = utcDateKey();
  const row = await env.DB.prepare(
    "SELECT used_audio_seconds, reserved_audio_seconds FROM daily_usage WHERE user_id = ? AND date_key = ?",
  ).bind(userId, dateKey).first<{ used_audio_seconds: number; reserved_audio_seconds: number }>();
  const used = row?.used_audio_seconds ?? 0;
  const reserved = row?.reserved_audio_seconds ?? 0;
  const resetAt = Date.parse(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return {
    limitAudioSeconds: 600,
    usedAudioSeconds: used,
    reservedAudioSeconds: reserved,
    remainingAudioSeconds: Math.max(0, 600 - used - reserved),
    resetAt,
  };
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_REQUEST", false, "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ApiError(400, "INVALID_REQUEST", false, "Enter a valid email address.");
  }
  return email;
}

function validateCodeChallenge(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(value)) {
    throw new ApiError(400, "INVALID_REQUEST", false, "The secure sign-in request is invalid.");
  }
  return value;
}

function sanitizeDeviceName(value: unknown): string {
  if (typeof value !== "string") return "Android device";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80);
  return cleaned || "Android device";
}

function invalidCode(): never {
  throw new ApiError(400, "INVALID_CODE", false, "The code is invalid or expired.");
}

function safeInfrastructureError(error: unknown): string {
  const source = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
  return source
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/[A-Za-z0-9_-]{30,}/gu, "[redacted-value]")
    .slice(0, 240);
}

function utcDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface SessionTokens {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}
