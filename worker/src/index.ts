import { createHandler } from "./handler";
import { productionAdminServices } from "./admin";
import {
  cleanupModerationData,
  processModerationNotifications,
  reactivateExpiredSuspensions,
  safeFailure,
} from "./moderation";
import { releaseExpiredReservations } from "./quota";
import { applyHistoryRetention, purgeLegacyVaults } from "./records";
import type { AppEnv } from "./types";

const handler = createHandler();

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    return handler(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: AppEnv): Promise<void> {
    // Each maintenance step runs on its own: a failure in one (a D1 hiccup, a
    // row that cannot be settled) previously aborted every later step on every
    // five-minute run, so suspensions, notices, and cleanup silently stopped.
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["release_expired_reservations", () => releaseExpiredReservations(env)],
      ["reactivate_expired_suspensions", () => reactivateExpiredSuspensions(env)],
      ["moderation_notifications", () => processModerationNotifications(env, productionAdminServices)],
      ["cleanup_moderation_data", () => cleanupModerationData(env)],
      ["cleanup_expired_credentials", () => cleanupExpiredCredentials(env)],
      ["history_retention", () => applyHistoryRetention(env)],
      ["purge_legacy_vaults", () => purgeLegacyVaults(env)],
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        console.error(JSON.stringify({ event: "scheduled_step_failed", step, reason: safeFailure(error) }));
      }
    }
  },
} satisfies ExportedHandler<AppEnv>;

async function cleanupExpiredCredentials(env: AppEnv): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_challenges WHERE expires_at < ?").bind(now - 86_400_000),
    env.DB.prepare("DELETE FROM authorization_codes WHERE expires_at < ?").bind(now - 86_400_000),
    env.DB.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").bind(now - 86_400_000),
    env.DB.prepare("DELETE FROM sessions WHERE absolute_expires_at < ? OR revoked_at < ?")
      .bind(now - 86_400_000, now - 30 * 86_400_000),
    env.DB.prepare("DELETE FROM admin_login_challenges WHERE expires_at < ?").bind(now - 86_400_000),
    env.DB.prepare(
      "DELETE FROM admin_browser_sessions WHERE absolute_expires_at < ? OR revoked_at < ?",
    ).bind(now - 86_400_000, now - 30 * 86_400_000),
  ]);
}
