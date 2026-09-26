import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64Url, sha256 } from "../src/crypto";
import { buildUsage, createHandler } from "../src/handler";
import { cleanupModerationData, processModerationNotifications } from "../src/moderation";
import { completeQuota, releaseExpiredReservations, releaseQuota, reserveQuota } from "../src/quota";
import { applyHistoryRetention, purgeLegacyVaults } from "../src/records";
import type { AdminServices, AppEnv, AuthServices, Services } from "../src/types";
import { extractCleanedText } from "../src/models";
import { chooseSafePolish } from "../src/validation";
import { validateWav } from "../src/wav";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

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

  it("enforces the transcription burst limiter", async () => {
    const services = fakeServices();
    const fixture = authFixture(services);
    const signedIn = await registerAndSignIn("limited@example.com", fixture);
    const response = await fixture.handler(
      transcriptionRequest(makeWav(1), signedIn.accessToken),
      fakeEnv(false),
    );
    expect(response.status).toBe(429);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
    expect(services.transcribe).not.toHaveBeenCalled();
  });

  it("keeps health checks out of the recording budget", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("health@example.com", fixture);
    const environment = fakeEnv(false);
    const response = await fixture.handler(
      new Request("https://worker.test/v1/health", { headers: bearer(signedIn.accessToken) }),
      environment,
    );
    expect(response.status).toBe(200);
    expect(environment.RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("validates and returns a polished transcription", async () => {
    const services = fakeServices("hello how are you", "Hello, how are you?");
    const fixture = authFixture(services);
    const signedIn = await registerAndSignIn("polish@example.com", fixture);
    const response = await fixture.handler(
      transcriptionRequest(makeWav(1), signedIn.accessToken),
      fixture.environment,
    );
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
    const fixture = authFixture(services);
    const signedIn = await registerAndSignIn("numbers@example.com", fixture);
    const response = await fixture.handler(
      transcriptionRequest(makeWav(1), signedIn.accessToken),
      fixture.environment,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({ text: "Meet me at 14:30", polished: false });
  });

  it("rejects malformed WAV input without calling inference", async () => {
    const services = fakeServices();
    const fixture = authFixture(services);
    const signedIn = await registerAndSignIn("wav@example.com", fixture);
    const response = await fixture.handler(
      transcriptionRequest(new Uint8Array(64).buffer, signedIn.accessToken),
      fixture.environment,
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

  it("stops counting guesses once a challenge is exhausted", async () => {
    const fixture = authFixture();
    const start = await fixture.handler(jsonRequest("/v1/auth/start", {
      email: "exhausted@example.com",
      turnstileToken: "turnstile-test-token",
      codeChallenge: await sha256("v".repeat(64)),
      termsAccepted: true,
    }), fixture.environment);
    const challengeId = ((await start.json()) as { challengeId: string }).challengeId;
    const code = fixture.sent.at(-1)!.code;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await fixture.handler(
        jsonRequest("/v1/auth/verify", { challengeId, code: wrong }),
        fixture.environment,
      );
      expect(response.status).toBe(400);
    }
    const row = await fixture.environment.DB.prepare("SELECT attempts FROM login_challenges WHERE id = ?")
      .bind(challengeId).first<{ attempts: number }>();
    expect(row?.attempts).toBe(5);
    const correct = await fixture.handler(jsonRequest("/v1/auth/verify", { challengeId, code }), fixture.environment);
    expect(correct.status).toBe(400);
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

  it("settles reservations after a lapsed quota grant leaves usage above the base limit", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("lapsed-grant@example.com", fixture);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    const userId = ((await me.json()) as { user: { id: string } }).user.id;
    const db = fixture.environment.DB;
    await db.prepare("UPDATE users SET quota_limit_audio_seconds = 1200, quota_override_expires_at = ? WHERE id = ?")
      .bind(Date.now() + 3_600_000, userId).run();
    await db.prepare(
      "INSERT INTO daily_usage(user_id, date_key, used_audio_seconds) VALUES(?, ?, 900)",
    ).bind(userId, new Date().toISOString().slice(0, 10)).run();
    const released = await reserveQuota(fixture.environment, userId, crypto.randomUUID(), 30);
    const completed = await reserveQuota(fixture.environment, userId, crypto.randomUUID(), 20);

    // The grant lapses (or an administrator clears it) while both are in flight.
    await db.prepare("UPDATE users SET quota_override_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 5_000, userId).run();
    await releaseQuota(fixture.environment, released);
    await completeQuota(fixture.environment, completed, 1);

    const usage = await db.prepare(
      "SELECT used_audio_seconds, reserved_audio_seconds FROM daily_usage WHERE user_id = ?",
    ).bind(userId).first<{ used_audio_seconds: number; reserved_audio_seconds: number }>();
    expect(usage).toMatchObject({ used_audio_seconds: 920, reserved_audio_seconds: 0 });
    const statuses = await db.prepare(
      "SELECT status FROM quota_reservations WHERE id IN (?, ?) ORDER BY status",
    ).bind(released.id, completed.id).all<{ status: string }>();
    expect(statuses.results.map((row) => row.status)).toEqual(["completed", "released"]);
    // Growth past the base limit is still refused once the grant is gone.
    await expect(reserveQuota(fixture.environment, userId, crypto.randomUUID(), 1))
      .rejects.toMatchObject({ code: "USER_QUOTA_EXCEEDED" });
  });

  it("prunes settled reservations but keeps in-flight ones", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("prune@example.com", fixture);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    const userId = ((await me.json()) as { user: { id: string } }).user.id;
    const settled = await reserveQuota(fixture.environment, userId, crypto.randomUUID(), 2);
    await completeQuota(fixture.environment, settled, 1);
    const inFlight = await reserveQuota(fixture.environment, userId, crypto.randomUUID(), 2);
    await cleanupModerationData(fixture.environment, Date.now() + 91 * 86_400_000);
    const remaining = await fixture.environment.DB.prepare(
      "SELECT id FROM quota_reservations WHERE id IN (?, ?)",
    ).bind(settled.id, inFlight.id).all<{ id: string }>();
    expect(remaining.results.map((row) => row.id)).toEqual([inFlight.id]);
    await releaseQuota(fixture.environment, inFlight);
    expect(await releaseExpiredReservations(fixture.environment)).toBeGreaterThanOrEqual(0);
  });

  it("returns the monthly email slot when a moderation notice fails to send", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("notice@example.com", fixture);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    const userId = ((await me.json()) as { user: { id: string } }).user.id;
    const db = fixture.environment.DB;
    const now = Date.now();
    await db.prepare(
      `INSERT INTO moderation_notifications
        (id, user_id, action, public_message, effective_until, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES(?, ?, 'suspended', 'Paused.', NULL, 'pending', 0, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, now - 1, now - 1, now - 1).run();
    const monthKey = new Date(now).toISOString().slice(0, 7);
    const before = await db.prepare("SELECT moderation_emails FROM service_monthly_usage WHERE month_key = ?")
      .bind(monthKey).first<{ moderation_emails: number }>();
    await processModerationNotifications(fixture.environment, {
      sendModerationEmail: vi.fn(async () => { throw new Error("mail down"); }),
    }, 25);
    const after = await db.prepare("SELECT moderation_emails FROM service_monthly_usage WHERE month_key = ?")
      .bind(monthKey).first<{ moderation_emails: number }>();
    expect(after?.moderation_emails ?? 0).toBe(before?.moderation_emails ?? 0);
  });

  it("rejects a sync batch that repeats the same record", async () => {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn("duplicate-sync@example.com", fixture);
    await fixture.handler(jsonRequest("/v1/sync/vault", {
      wrappedKey: "d3JhcHBlZA",
      nonce: "bm9uY2U",
      keyVersion: 1,
      expectedKeyVersion: null,
    }, signedIn.accessToken, "PUT"), fixture.environment);
    const item = { id: "record-dup", type: "history", baseVersion: 0, keyVersion: 1, nonce: "YWJj", ciphertext: "ZGVm", deleted: false };
    const response = await fixture.handler(jsonRequest("/v1/sync/batch", {
      items: [item, { ...item, deleted: true }],
    }, signedIn.accessToken), fixture.environment);
    expect(response.status).toBe(400);
    expect((await response.json()) as object).toMatchObject({ error: { code: "INVALID_REQUEST" } });
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

describe("cloud sync (v2)", () => {
  async function signedInUser(email: string) {
    const fixture = authFixture();
    const signedIn = await registerAndSignIn(email, fixture);
    const me = await fixture.handler(
      new Request("https://worker.test/v1/me", { headers: bearer(signedIn.accessToken) }),
      fixture.environment,
    );
    const userId = ((await me.json()) as { user: { id: string } }).user.id;
    const call = (path: string, init: { method?: string; body?: unknown } = {}) => fixture.handler(
      init.body === undefined
        ? new Request(`https://worker.test${path}`, { method: init.method ?? "GET", headers: bearer(signedIn.accessToken) })
        : jsonRequest(path, init.body, signedIn.accessToken, init.method ?? "POST"),
      fixture.environment,
    );
    return { fixture, userId, call, db: fixture.environment.DB };
  }
  const history = (id: string, text: string, baseVersion = 0) => ({
    id, type: "history", baseVersion, deleted: false, payload: { schemaVersion: 1, text, createdAtMs: 1_790_000_000_000 },
  });

  it("stores records sealed with the account key and returns plain payloads", async () => {
    const { call, db, userId } = await signedInUser("cloud@example.com");
    const push = await call("/v2/sync/batch", { body: { items: [history("h1", "Meet Rahim at the clinic.")] } });
    expect(push.status).toBe(200);
    expect((await push.json()) as object).toMatchObject({ applied: [{ id: "h1", type: "history", version: 1 }] });
    const stored = await db.prepare("SELECT ciphertext, nonce FROM sync_records WHERE user_id = ?")
      .bind(userId).first<{ ciphertext: string; nonce: string }>();
    expect(stored?.ciphertext).toBeTruthy();
    expect(atob(stored!.ciphertext.replaceAll("-", "+").replaceAll("_", "/") + "==".slice(0, (4 - stored!.ciphertext.length % 4) % 4)))
      .not.toContain("Rahim");
    const user = await db.prepare("SELECT data_key_wrapped, data_key_kek_version FROM users WHERE id = ?")
      .bind(userId).first<{ data_key_wrapped: string; data_key_kek_version: number }>();
    expect(user?.data_key_wrapped).toBeTruthy();
    expect(user?.data_key_kek_version).toBe(1);
    const pull = await call("/v2/sync?cursor=0");
    expect((await pull.json()) as object).toMatchObject({
      hasMore: false,
      items: [{ id: "h1", type: "history", version: 1, deleted: false, payload: { text: "Meet Rahim at the clinic." } }],
      settings: { historySyncEnabled: true, historyRetentionDays: null, legacyVault: false },
    });
  });

  it("keeps one change row per record and reports conflicts with the server copy", async () => {
    const { call, db, userId } = await signedInUser("feed@example.com");
    await call("/v2/sync/batch", { body: { items: [history("h1", "First draft.")] } });
    await call("/v2/sync/batch", { body: { items: [history("h1", "Second draft.", 1)] } });
    const feed = await db.prepare("SELECT COUNT(*) AS count FROM sync_record_changes WHERE user_id = ?")
      .bind(userId).first<{ count: number }>();
    expect(feed?.count).toBe(1);
    const conflict = await call("/v2/sync/batch", { body: { items: [history("h1", "Stale edit.", 1)] } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as object).toMatchObject({
      error: { code: "SYNC_CONFLICT" },
      conflicts: [{ id: "h1", version: 2, payload: { text: "Second draft." } }],
    });
  });

  it("turning history sync off deletes the cloud copy and refuses new history", async () => {
    const { call, db, userId } = await signedInUser("private@example.com");
    await call("/v2/sync/batch", { body: { items: [history("h1", "Private note.")] } });
    const off = await call("/v2/sync/settings", { method: "PUT", body: { historySyncEnabled: false, historyRetentionDays: 30 } });
    expect((await off.json()) as object).toMatchObject({ settings: { historySyncEnabled: false, historyRetentionDays: 30 } });
    const left = await db.prepare("SELECT COUNT(*) AS count FROM sync_records WHERE user_id = ?")
      .bind(userId).first<{ count: number }>();
    expect(left?.count).toBe(0);
    const refused = await call("/v2/sync/batch", { body: { items: [history("h2", "Another.")] } });
    expect(refused.status).toBe(409);
    expect((await refused.json()) as object).toMatchObject({ error: { code: "HISTORY_SYNC_DISABLED" } });
    const invalid = await call("/v2/sync/settings", { method: "PUT", body: { historyRetentionDays: 7 } });
    expect(invalid.status).toBe(400);
  });

  it("deletes history past the account's retention on every device", async () => {
    const { call, db, userId } = await signedInUser("retention@example.com");
    await call("/v2/sync/batch", { body: { items: [history("old", "Old note."), {
      ...history("new", "New note."), payload: { text: "New note.", createdAtMs: Date.now() },
    }] } });
    await call("/v2/sync/settings", { method: "PUT", body: { historyRetentionDays: 30 } });
    await db.prepare("UPDATE sync_records SET created_at = ? WHERE user_id = ? AND item_id = 'old'")
      .bind(Date.now() - 31 * 86_400_000, userId).run();
    expect(await applyHistoryRetention(fixtureEnv(db))).toBeGreaterThanOrEqual(1);
    const pull = await call("/v2/sync?cursor=0");
    const items = ((await pull.json()) as { items: Array<{ id: string; deleted: boolean }> }).items;
    expect(items.find((item) => item.id === "old")).toMatchObject({ deleted: true });
    expect(items.find((item) => item.id === "new")).toMatchObject({ deleted: false });
  });

  it("refuses dictionary terms beyond the account limit", async () => {
    const { call, db, userId } = await signedInUser("dictionary-cap@example.com");
    await db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
       INSERT INTO sync_records (user_id, item_type, item_id, version, key_version, nonce, ciphertext, deleted, created_at, modified_at)
       SELECT ?, 'dictionary', 'd' || i, 1, 1, 'bm9uY2U', 'Y2lwaGVy', 0, 1, 1 FROM n`,
    ).bind(userId).run();
    const response = await call("/v2/sync/batch", { body: { items: [{
      id: "one-more", type: "dictionary", baseVersion: 0, deleted: false,
      payload: { term: "Kubernetes", normalizedTerm: "kubernetes", createdAtMs: 1 },
    }] } });
    expect(response.status).toBe(413);
    expect((await response.json()) as object).toMatchObject({ error: { code: "STORAGE_LIMIT_REACHED" } });
  });

  it("re-wraps the account key after a SYNC_KEK rotation", async () => {
    const { fixture, call, db, userId } = await signedInUser("rotation@example.com");
    await call("/v2/sync/batch", { body: { items: [history("h1", "Before rotation.")] } });
    fixture.environment.SYNC_KEK_PREVIOUS = fixture.environment.SYNC_KEK;
    fixture.environment.SYNC_KEK = base64Url(new Uint8Array(32).fill(11));
    fixture.environment.SYNC_KEK_VERSION = "2";
    const pull = await call("/v2/sync?cursor=0");
    expect((await pull.json()) as object).toMatchObject({ items: [{ payload: { text: "Before rotation." } }] });
    const user = await db.prepare("SELECT data_key_kek_version FROM users WHERE id = ?")
      .bind(userId).first<{ data_key_kek_version: number }>();
    expect(user?.data_key_kek_version).toBe(2);
  });

  it("closes v1 sync once an account has migrated and purges its vault later", async () => {
    const { call, db, userId } = await signedInUser("legacy@example.com");
    await call("/v1/sync/vault", { method: "PUT", body: {
      wrappedKey: "d3JhcHBlZA", nonce: "bm9uY2U", keyVersion: 1, expectedKeyVersion: null,
    } });
    const settings = await call("/v2/sync/settings");
    expect((await settings.json()) as object).toMatchObject({ settings: { legacyVault: true } });
    expect((await call("/v1/sync?cursor=0")).status).toBe(200);
    await call("/v2/sync/migration", { body: {} });
    const closed = await call("/v1/sync?cursor=0");
    expect(closed.status).toBe(426);
    expect((await closed.json()) as object).toMatchObject({ error: { code: "UPGRADE_REQUIRED" } });
    await db.prepare("UPDATE users SET sync_v1_migrated_at = ? WHERE id = ?").bind(Date.now() - 31 * 86_400_000, userId).run();
    await purgeLegacyVaults(fixtureEnv(db));
    const user = await db.prepare("SELECT wrapped_vault_key FROM users WHERE id = ?").bind(userId).first<{ wrapped_vault_key: string | null }>();
    expect(user?.wrapped_vault_key).toBeNull();
  });
});

function fixtureEnv(db: D1Database): AppEnv {
  const environment = fakeEnv();
  environment.DB = db;
  return environment;
}

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

describe("cleanup response parsing", () => {
  it("accepts any single-string object shape the model returns", () => {
    expect(extractCleanedText('{"cleaned_transcript":"Hello there."}')).toBe("Hello there.");
    expect(extractCleanedText('```json\n{"text":"Hi."}\n```')).toBe("Hi.");
    expect(extractCleanedText('"Quoted."')).toBe("Quoted.");
    expect(extractCleanedText("Plain prose.")).toBe("Plain prose.");
  });

  it("never passes JSON plumbing through as the transcript", () => {
    expect(extractCleanedText('{"cleaned_transcript":"You can generate a new sign-in')).toBeNull();
    expect(extractCleanedText('{"a":"one","b":"two"}')).toBeNull();
    expect(extractCleanedText("[1, 2]")).toBeNull();
    expect(chooseSafePolish(
      "you can generate a new sign in value again",
      '{"cleaned_transcript":"You can generate a new sign-in value again."}',
    )).toBeNull();
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

function authFixture(services: Services = fakeServices()) {
  const sent: Array<{ email: string; code: string }> = [];
  const authServices: AuthServices = {
    verifyTurnstile: vi.fn(async () => true),
    sendCode: vi.fn(async (_environment, email, code) => { sent.push({ email, code }); }),
  };
  const environment = fakeEnv();
  return {
    sent,
    environment,
    handler: createHandler(services, authServices),
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
    USER_API_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    AI: {} as never,
    ASSETS: {} as never,
    ASR_MODEL: "whisper",
    APP_ORIGIN: "https://worker.test",
    ENVIRONMENT: "test",
    TURNSTILE_SITE_KEY: "test-site-key",
    AUTH_MASTER_KEY: "test-auth-master-key-with-enough-entropy",
    PII_KEY,
    TURNSTILE_SECRET: "test-secret",
    SYNC_KEK: base64Url(new Uint8Array(32).fill(9)),
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
