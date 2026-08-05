import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64Url, sha256 } from "../src/crypto";
import { buildUsage, createHandler } from "../src/handler";
import { completeQuota, releaseQuota, reserveQuota } from "../src/quota";
import type { AdminServices, AppEnv, AuthServices, Services } from "../src/types";
import { chooseSafePolish } from "../src/validation";
import { validateWav } from "../src/wav";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const LEGACY_TOKEN = "test-device-token-with-enough-entropy";
const PII_KEY = base64Url(new Uint8Array(32).fill(7));

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // The Workers test database is shared for the file. Remove expired-style
  // challenge state so repeated admin-account verification remains isolated.
  await env.DB.prepare("DELETE FROM login_challenges").run();
  await env.DB.prepare("DELETE FROM admin_browser_sessions").run();
  await env.DB.prepare("DELETE FROM admin_login_challenges").run();
});

describe("WoVoice Worker", () => {
  it("provides a public status response without exposing protected data", async () => {
    const response = await createHandler(fakeServices())(
      new Request("https://worker.test/v1/status"),
      fakeEnv(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      name: "WoVoice API",
      status: "online",
      apiVersion: "v1",
    });
  });

  it("serves the current, legacy, and local-development App Link certificates", async () => {
    const production = fakeEnv();
    production.ENVIRONMENT = "production";
    const productionResponse = await createHandler(fakeServices())(
      new Request("https://wovoice.aliahad.com/.well-known/assetlinks.json"),
      production,
    );
    const productionBody = JSON.stringify(await productionResponse.json());
    expect(productionResponse.headers.get("cache-control")).toBe("no-store");
    expect(productionBody).toContain('"package_name":"com.aliahad.wovoice"');
    expect(productionBody).toContain("61:E2:D4:78:A0:75:E3:FD");
    expect(productionBody).toContain("3A:E4:93:35:28:83:E2:7F");
    expect(productionBody).toContain("EC:F2:BE:43:B8:6F:94:29");
  });

  it("serves callback recovery assets without caching authorization codes", async () => {
    const environment = fakeEnv();
    const fetchAsset = vi.fn(async () => new Response("callback", {
      headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "text/html" },
    }));
    environment.ASSETS = { fetch: fetchAsset } as unknown as Fetcher;

    const response = await createHandler(fakeServices())(
      new Request("https://wovoice.aliahad.com/app/callback?code=secret&state=state"),
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(await response.text()).toBe("callback");
  });

  it("rejects unauthenticated transcription before parsing audio", async () => {
    const response = await createHandler(fakeServices())(
      new Request("https://worker.test/v1/transcriptions", { method: "POST" }),
      fakeEnv(),
    );
    expect(response.status).toBe(401);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "AUTH_REQUIRED", retryable: false },
    });
  });

  it("supports the old production token only during the migration window", async () => {
    const response = await createHandler(fakeServices())(
      new Request("https://wovoice-transcription.aliahad.workers.dev/v1/health", {
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      }),
      fakeEnv(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({ ok: true });
  });

  it("requires an upgrade after the legacy migration deadline", async () => {
    const environment = fakeEnv();
    environment.LEGACY_AUTH_DEADLINE = "2000-01-01T00:00:00.000Z";
    const response = await createHandler(fakeServices())(
      new Request("https://wovoice-transcription.aliahad.workers.dev/v1/health", {
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      }),
      environment,
    );
    expect(response.status).toBe(426);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "UPGRADE_REQUIRED", retryable: false },
    });
  });

  it("enforces the transcription burst limiter", async () => {
    const environment = fakeEnv(false);
    const response = await createHandler(fakeServices())(
      new Request("https://wovoice-transcription.aliahad.workers.dev/v1/health", {
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      }),
      environment,
    );
    expect(response.status).toBe(429);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
  });

  it("validates and returns a polished legacy transcription", async () => {
    const services = fakeServices("hello how are you", "Hello, how are you?");
    const response = await createHandler(services)(legacyTranscriptionRequest(makeWav(1)), fakeEnv());
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      text: "Hello, how are you?",
      rawText: "hello how are you",
      polished: true,
      asrModel: "whisper-large-v3-turbo",
      usage: {
        estimated: true,
        currency: "USD",
        audioSeconds: 1,
        inputTokens: 80,
        outputTokens: 20,
      },
    });
  });

  it("falls back to raw ASR when cleanup changes a number", async () => {
    const services = fakeServices("Meet me at 14:30", "Meet me at 4:30.");
    const response = await createHandler(services)(legacyTranscriptionRequest(makeWav(1)), fakeEnv());
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({ text: "Meet me at 14:30", polished: false });
  });

  it("rejects malformed WAV input without calling inference", async () => {
    const services = fakeServices();
    const response = await createHandler(services)(
      legacyTranscriptionRequest(new Uint8Array(64).buffer),
      fakeEnv(),
    );
    expect(response.status).toBe(400);
    expect(services.transcribe).not.toHaveBeenCalled();
  });
});

describe("passwordless accounts", () => {
  it("verifies an email code, exchanges PKCE, and exposes account quota", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("person@example.com", fixture);
    const response = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      user: { email: "person@example.com", vaultConfigured: false },
      quota: { limitAudioSeconds: 600, usedAudioSeconds: 0 },
    });
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]?.email).toBe("person@example.com");
  });

  it("rotates refresh tokens and revokes a session when an old token is reused", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("rotate@example.com", fixture);
    const first = await fixture.handler(jsonRequest("/v1/auth/refresh", {
      refreshToken: signedIn.refreshToken,
    }), fixture.environment);
    expect(first.status).toBe(200);
    const rotated = await first.json() as { accessToken: string };
    const reuse = await fixture.handler(jsonRequest("/v1/auth/refresh", {
      refreshToken: signedIn.refreshToken,
    }), fixture.environment);
    expect(reuse.status).toBe(401);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(rotated.accessToken) }),
      fixture.environment,
    );
    expect(me.status).toBe(401);
  });

  it("allows an email challenge to produce only one authorization code", async () => {
    const fixture = authFixture();
    const challenge = await sha256("v".repeat(64));
    const start = await fixture.handler(jsonRequest("/v1/auth/start", {
      email: "single-use@example.com",
      turnstileToken: "turnstile-test-token",
      codeChallenge: challenge,
      termsAccepted: true,
    }), fixture.environment);
    const challengeId = ((await start.json()) as { challengeId: string }).challengeId;
    const code = fixture.sent[0]!.code;
    const attempts = await Promise.all([
      fixture.handler(jsonRequest("/v1/auth/verify", { challengeId, code }), fixture.environment),
      fixture.handler(jsonRequest("/v1/auth/verify", { challengeId, code }), fixture.environment),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it("returns a stable error at the exact monthly email ceiling", async () => {
    const fixture = authFixture();
    const monthKey = new Date().toISOString().slice(0, 7);
    await fixture.environment.DB.prepare(
      "INSERT OR REPLACE INTO service_monthly_usage(month_key, verification_emails) VALUES(?, 2500)",
    ).bind(monthKey).run();
    const response = await fixture.handler(jsonRequest("/v1/auth/start", {
      email: "email-limit@example.com",
      turnstileToken: "turnstile-test-token",
      codeChallenge: await sha256("v".repeat(64)),
      termsAccepted: true,
    }), fixture.environment);
    await fixture.environment.DB.prepare(
      "UPDATE service_monthly_usage SET verification_emails = 0 WHERE month_key = ?",
    ).bind(monthKey).run();
    expect(response.status).toBe(503);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "EMAIL_RATE_LIMITED", retryable: true },
    });
    expect(fixture.sent).toHaveLength(0);
  });

  it("accounts successful inference against the verified user's daily quota", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("quota@example.com", fixture);
    const response = await fixture.handler(
      transcriptionRequest(makeWav(2), signedIn.accessToken),
      fixture.environment,
    );
    expect(response.status).toBe(200);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    expect((await me.json()) as object).toMatchObject({ quota: { usedAudioSeconds: 2 } });
  });

  it("does not charge a reservation that was already released", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("released@example.com", fixture);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    const userId = ((await me.json()) as { user: { id: string } }).user.id;
    const reservation = await reserveQuota(fixture.environment, userId, crypto.randomUUID(), 5);
    await releaseQuota(fixture.environment, reservation);
    await completeQuota(fixture.environment, reservation, 2);
    const usage = await fixture.environment.DB.prepare(
      "SELECT used_audio_seconds, reserved_audio_seconds FROM daily_usage WHERE user_id = ?",
    ).bind(userId).first<{ used_audio_seconds: number; reserved_audio_seconds: number }>();
    expect(usage).toMatchObject({ used_audio_seconds: 0, reserved_audio_seconds: 0 });
  });

  it("stores only opaque encrypted sync items and reports optimistic conflicts", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("sync@example.com", fixture);
    const vault = await fixture.handler(jsonRequest("/v1/sync/vault", {
      wrappedKey: "d3JhcHBlZA",
      nonce: "bm9uY2U",
      keyVersion: 1,
      expectedKeyVersion: null,
    }, signedIn.accessToken, "PUT"), fixture.environment);
    expect(vault.status).toBe(200);
    const write = await fixture.handler(jsonRequest("/v1/sync/batch", {
      items: [{ id: "record-1", type: "history", baseVersion: 0, keyVersion: 1, nonce: "YWJj", ciphertext: "ZGVm", deleted: false }],
    }, signedIn.accessToken), fixture.environment);
    expect(write.status).toBe(200);
    const conflict = await fixture.handler(jsonRequest("/v1/sync/batch", {
      items: [{ id: "record-1", type: "history", baseVersion: 0, keyVersion: 1, nonce: "YWJj", ciphertext: "Z2hp", deleted: false }],
    }, signedIn.accessToken), fixture.environment);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as object).toMatchObject({ error: { code: "SYNC_CONFLICT" } });
    const pull = await fixture.handler(
      new Request("https://worker.test/v1/sync?cursor=0", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    expect((await pull.json()) as object).toMatchObject({
      items: [{ id: "record-1", ciphertext: "ZGVm", version: 1 }],
    });
  });
});

describe("admin moderation", () => {
  it("redirects protected admin pages to the first-party login", async () => {
    const fixture = adminFixture();
    const response = await fixture.handler(
      new Request("https://worker.test/admin/"),
      fixture.environment,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login?returnTo=");
  });

  it("does not enumerate or email ordinary accounts through admin login", async () => {
    const fixture = adminFixture();
    await registerAndSignIn("person@example.com", fixture);
    const sentBefore = fixture.sent.length;
    const start = await fixture.handler(adminAuthRequest("/auth/start", {
      email: "person@example.com",
      turnstileToken: "turnstile-test-token",
    }), fixture.environment);
    expect(start.status).toBe(200);
    expect(fixture.sent).toHaveLength(sentBefore);
    const challengeId = ((await start.json()) as { challengeId: string }).challengeId;
    const verify = await fixture.handler(adminAuthRequest("/auth/verify", {
      challengeId,
      code: "123456",
    }), fixture.environment);
    expect(verify.status).toBe(400);
    expect((await verify.json()) as object).toMatchObject({ error: { code: "INVALID_CODE" } });
  });

  it("creates a secure first-party session for the D1 administrator", async () => {
    const fixture = adminFixture();
    const browser = await registerAndSignInAdmin(fixture);
    const session = await fixture.handler(adminRequest("/session", browser), fixture.environment);
    expect(session.status).toBe(200);
    expect((await session.json()) as object).toMatchObject({
      admin: { email: "aliahadmd1@gmail.com", role: "admin" },
    });
    expect(browser.setCookies.join(";")).toContain("HttpOnly");
    expect(browser.setCookies.join(";")).toContain("SameSite=Strict");
    expect(browser.setCookies.join(";")).toContain("Secure");

    const users = await fixture.handler(adminRequest("/users?query=aliahadmd1%40gmail.com", browser), fixture.environment);
    const body = await users.json() as { users: Array<Record<string, unknown>> };
    expect(users.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).not.toHaveProperty("ciphertext");
    expect(body.users[0]).not.toHaveProperty("transcript");
    expect(JSON.stringify(body)).not.toContain("aliahadmd1@gmail.com");
  });

  it("suspends atomically, revokes sessions, audits, and permits a restricted re-login", async () => {
    const fixture = adminFixture();
    const browser = await registerAndSignInAdmin(fixture);
    const member = await registerAndSignIn("member@example.com", fixture);
    const profile = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(member.accessToken) }),
      fixture.environment,
    );
    const memberId = ((await profile.json()) as { user: { id: string } }).user.id;

    const suspension = await fixture.handler(adminRequest(`/users/${memberId}/status`, browser, "POST", {
      status: "suspended",
      suspendedUntil: Date.now() + 86_400_000,
      publicMessage: "Please contact support about this account.",
      internalReason: "Automated abuse threshold review",
    }), fixture.environment);
    expect(suspension.status).toBe(200);
    expect(fixture.moderation).toHaveLength(1);

    const oldSession = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(member.accessToken) }),
      fixture.environment,
    );
    expect(oldSession.status).toBe(401);

    await fixture.environment.DB.prepare("DELETE FROM login_challenges").run();
    const restricted = await registerAndSignIn("member@example.com", fixture);
    const restrictedProfile = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(restricted.accessToken) }),
      fixture.environment,
    );
    expect(restrictedProfile.status).toBe(200);
    expect((await restrictedProfile.json()) as object).toMatchObject({
      user: { accountStatus: { state: "suspended", publicMessage: "Please contact support about this account." } },
    });
    const denied = await fixture.handler(
      transcriptionRequest(makeWav(1), restricted.accessToken),
      fixture.environment,
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as object).toMatchObject({ error: { code: "ACCOUNT_SUSPENDED" } });

    const audit = await fixture.handler(adminRequest("/audit?action=user_suspended", browser), fixture.environment);
    expect((await audit.json()) as object).toMatchObject({
      audit: [{ targetUserId: memberId, action: "user_suspended", internalReason: "Automated abuse threshold review" }],
    });
  });

  it("rejects cross-origin mutations and protects the administrator from self-moderation", async () => {
    const fixture = adminFixture();
    const browser = await registerAndSignInAdmin(fixture);
    const administrator = browser.android;
    const profile = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(administrator.accessToken) }),
      fixture.environment,
    );
    const administratorId = ((await profile.json()) as { user: { id: string } }).user.id;
    const wrongOrigin = await fixture.handler(adminRequest(
      `/users/${administratorId}/status`,
      browser,
      "POST",
      { status: "banned", internalReason: "Attempted self ban" },
      "https://attacker.example",
    ), fixture.environment);
    expect(wrongOrigin.status).toBe(403);

    const selfBan = await fixture.handler(adminRequest(`/users/${administratorId}/status`, browser, "POST", {
      status: "banned",
      internalReason: "Attempted self ban",
    }), fixture.environment);
    expect(selfBan.status).toBe(409);
    expect((await selfBan.json()) as object).toMatchObject({ error: { code: "INVALID_STATUS_TRANSITION" } });
  });

  it("blocks a transcription that finishes after the account is banned", async () => {
    let releaseAsr: ((value: { text: string; model: "whisper-large-v3-turbo" }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const asr = new Promise<{ text: string; model: "whisper-large-v3-turbo" }>((resolve) => {
      releaseAsr = resolve;
    });
    const services: Services = {
      transcribe: vi.fn(async () => {
        markStarted?.();
        return asr;
      }),
      polish: vi.fn(async () => ({ text: "Late text.", inputTokens: 10, outputTokens: 4 })),
    };
    const fixture = adminFixture(services);
    const browser = await registerAndSignInAdmin(fixture);
    const member = await registerAndSignIn("late-ban@example.com", fixture);
    const profile = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(member.accessToken) }),
      fixture.environment,
    );
    const memberId = ((await profile.json()) as { user: { id: string } }).user.id;

    const pending = fixture.handler(transcriptionRequest(makeWav(1), member.accessToken), fixture.environment);
    await started;
    const ban = await fixture.handler(adminRequest(`/users/${memberId}/status`, browser, "POST", {
      status: "banned",
      publicMessage: "Cloud access has been disabled.",
      internalReason: "Confirmed abuse during an active request",
    }), fixture.environment);
    expect(ban.status).toBe(200);
    releaseAsr?.({ text: "late text", model: "whisper-large-v3-turbo" });
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()) as object).toMatchObject({ error: { code: "ACCOUNT_BANNED" } });
    const reservation = await fixture.environment.DB.prepare(
      "SELECT status FROM quota_reservations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(memberId).first<{ status: string }>();
    expect(reservation?.status).toBe("released");
  });

  it("requires same-origin CSRF protection and revokes logout sessions", async () => {
    const fixture = adminFixture();
    const browser = await registerAndSignInAdmin(fixture);
    const missingCsrf = await fixture.handler(adminRequest("/logout", { ...browser, csrf: "" }, "POST"), fixture.environment);
    expect(missingCsrf.status).toBe(403);

    const logout = await fixture.handler(adminRequest("/logout", browser, "POST"), fixture.environment);
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().join(";")).toContain("Max-Age=0");
    const expired = await fixture.handler(adminRequest("/session", browser), fixture.environment);
    expect(expired.status).toBe(401);
  });

  it("expires idle browser sessions and rechecks the administrator account state", async () => {
    const fixture = adminFixture();
    const browser = await registerAndSignInAdmin(fixture);
    await fixture.environment.DB.prepare(
      "UPDATE admin_browser_sessions SET idle_expires_at = ? WHERE revoked_at IS NULL",
    ).bind(Date.now() - 1).run();
    const idleExpired = await fixture.handler(adminRequest("/session", browser), fixture.environment);
    expect(idleExpired.status).toBe(401);

    await fixture.environment.DB.prepare("DELETE FROM admin_login_challenges").run();
    const fresh = await signInExistingAdmin(fixture);
    await fixture.environment.DB.prepare(
      "UPDATE users SET status = 'banned' WHERE role = 'admin'",
    ).run();
    const restricted = await fixture.handler(adminRequest("/session", fresh), fixture.environment);
    expect(restricted.status).toBe(403);
    expect((await restricted.json()) as object).toMatchObject({ error: { code: "ADMIN_REQUIRED" } });
  });
});

describe("output safety", () => {
  it("accepts punctuation-only cleanup", () => {
    expect(chooseSafePolish("this works right", "This works, right?")).toBe("This works, right?");
  });
  it("rejects meaning-changing rewrites", () => {
    expect(chooseSafePolish("Please call Rahim tomorrow", "Cancel the appointment today")).toBeNull();
  });
});

describe("WAV validation", () => {
  it("accepts mono PCM 16 kHz", () => {
    expect(validateWav(makeWav(2)).durationSeconds).toBe(2);
  });
  it("rejects audio longer than 60 seconds", () => {
    expect(() => validateWav(makeWav(60.2))).toThrow("60 seconds");
  });
});

describe("usage estimates", () => {
  it("uses versioned Whisper and token pricing", () => {
    expect(buildUsage("whisper-large-v3-turbo", 60, { input: 1_000, output: 500 })).toMatchObject({
      pricingVersion: "2026-07-08",
      asrNeurons: 46.63,
      inputTokens: 1_000,
      outputTokens: 500,
    });
  });
  it("returns null rather than inventing missing token usage", () => {
    expect(buildUsage("nova-3", 10, null)).toBeNull();
  });
});

function authFixture() {
  const sent: Array<{ email: string; code: string }> = [];
  const authServices: AuthServices = {
    verifyTurnstile: vi.fn(async () => true),
    sendCode: vi.fn(async (_environment, email, code) => { sent.push({ email, code }); }),
  };
  const environment = fakeEnv();
  return {
    sent,
    environment,
    handler: createHandler(fakeServices(), authServices),
  };
}

function adminFixture(services: Services = fakeServices()) {
  const sent: Array<{ email: string; code: string }> = [];
  const moderation: Array<{ to: string; state: string }> = [];
  const authServices: AuthServices = {
    verifyTurnstile: vi.fn(async () => true),
    sendCode: vi.fn(async (_environment, email, code) => { sent.push({ email, code }); }),
  };
  const adminServices: AdminServices = {
    sendModerationEmail: vi.fn(async (_environment, message) => {
      moderation.push({ to: message.to, state: message.state });
    }),
  };
  const environment = fakeEnv();
  return {
    sent,
    moderation,
    environment,
    handler: createHandler(services, authServices, adminServices),
  };
}

interface AdminBrowserSession {
  cookie: string;
  csrf: string;
  setCookies: string[];
  android: { accessToken: string; refreshToken: string };
}

async function registerAndSignInAdmin(
  fixture: ReturnType<typeof adminFixture>,
): Promise<AdminBrowserSession> {
  fixture.environment.ADMIN_BOOTSTRAP_EMAIL = "aliahadmd1@gmail.com";
  const android = await registerAndSignIn("aliahadmd1@gmail.com", fixture);
  return signInExistingAdmin(fixture, android);
}

async function signInExistingAdmin(
  fixture: ReturnType<typeof adminFixture>,
  android: { accessToken: string; refreshToken: string } = { accessToken: "", refreshToken: "" },
): Promise<AdminBrowserSession> {
  const start = await fixture.handler(adminAuthRequest("/auth/start", {
    email: "aliahadmd1@gmail.com",
    turnstileToken: "turnstile-test-token",
  }), fixture.environment);
  expect(start.status).toBe(200);
  const challengeId = ((await start.json()) as { challengeId: string }).challengeId;
  const code = fixture.sent.at(-1)?.code;
  expect(code).toMatch(/^\d{6}$/u);
  const verification = await fixture.handler(adminAuthRequest("/auth/verify", {
    challengeId,
    code,
  }), fixture.environment);
  expect(verification.status).toBe(200);
  const setCookies = verification.headers.getSetCookie();
  const values = setCookies.map((value) => value.split(";", 1)[0]);
  const csrfPair = values.find((value) => value.startsWith("__Host-wovoice-admin-csrf="));
  expect(csrfPair).toBeDefined();
  return {
    cookie: values.join("; "),
    csrf: csrfPair?.slice(csrfPair.indexOf("=") + 1) ?? "",
    setCookies,
    android,
  };
}

async function registerAndSignIn(
  email: string,
  fixture: ReturnType<typeof authFixture>,
): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = "v".repeat(64);
  const challenge = await sha256(verifier);
  const start = await fixture.handler(jsonRequest("/v1/auth/start", {
    email,
    turnstileToken: "turnstile-test-token",
    codeChallenge: challenge,
    termsAccepted: true,
  }), fixture.environment);
  expect(start.status).toBe(200);
  const started = await start.json() as { challengeId: string };
  const code = fixture.sent.at(-1)?.code;
  expect(code).toMatch(/^\d{6}$/u);
  const verification = await fixture.handler(jsonRequest("/v1/auth/verify", {
    challengeId: started.challengeId,
    code,
  }), fixture.environment);
  expect(verification.status).toBe(200);
  const verified = await verification.json() as { authorizationCode: string };
  const exchange = await fixture.handler(jsonRequest("/v1/auth/token", {
    grantType: "authorization_code",
    code: verified.authorizationCode,
    codeVerifier: verifier,
    deviceName: "Test Android",
  }), fixture.environment);
  expect(exchange.status).toBe(200);
  return exchange.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

function fakeServices(raw = "hello", polished = "Hello."): Services {
  return {
    transcribe: vi.fn(async () => ({ text: raw, model: "whisper-large-v3-turbo" as const })),
    polish: vi.fn(async () => ({ text: polished, inputTokens: 80, outputTokens: 20 })),
  };
}

function fakeEnv(rateSuccess = true): AppEnv {
  return {
    DB: env.DB,
    EMAIL: {} as never,
    RATE_LIMITER: { limit: vi.fn(async () => ({ success: rateSuccess })) },
    AUTH_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    AI: {} as never,
    ASSETS: {} as never,
    ASR_MODEL: "whisper",
    APP_ORIGIN: "https://worker.test",
    ENVIRONMENT: "test",
    TURNSTILE_SITE_KEY: "test-site-key",
    LEGACY_AUTH_DEADLINE: "2099-01-01T00:00:00.000Z",
    AUTH_MASTER_KEY: "test-auth-master-key-with-enough-entropy",
    PII_KEY,
    TURNSTILE_SECRET: "test-secret",
    CLIENT_TOKEN: LEGACY_TOKEN,
  };
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function jsonRequest(path: string, body: unknown, token?: string, method = "POST"): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(`https://worker.test${path}`, { method, headers, body: JSON.stringify(body) });
}

function adminRequest(
  path: string,
  session: Pick<AdminBrowserSession, "cookie" | "csrf">,
  method = "GET",
  body?: unknown,
  origin = "https://worker.test",
): Request {
  const headers = new Headers({
    Accept: "application/json",
    Cookie: session.cookie,
  });
  if (!["GET", "HEAD"].includes(method)) {
    headers.set("Origin", origin);
    headers.set("Sec-Fetch-Site", "same-origin");
    if (session.csrf) headers.set("X-WoVoice-CSRF", session.csrf);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://worker.test/admin/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function adminAuthRequest(path: string, body: unknown): Request {
  return new Request(`https://worker.test/admin/api/v1${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://worker.test",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function legacyTranscriptionRequest(audio: ArrayBuffer): Request {
  return transcriptionRequest(audio, LEGACY_TOKEN, "https://wovoice-transcription.aliahad.workers.dev");
}

function transcriptionRequest(audio: ArrayBuffer, token: string, origin = "https://worker.test"): Request {
  const form = new FormData();
  form.set("audio", new File([audio], "voice.wav", { type: "audio/wav" }));
  form.set("options", JSON.stringify({
    locale: "en-IN",
    polish: "light",
    sentenceStart: true,
    commands: ["new_line", "new_paragraph"],
    glossary: ["Rahim"],
  }));
  return new Request(`${origin}/v1/transcriptions`, { method: "POST", headers: bearer(token), body: form });
}

function makeWav(seconds: number): ArrayBuffer {
  const dataSize = Math.round(seconds * 16_000 * 2);
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  return buffer;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}
