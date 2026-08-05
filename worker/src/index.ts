import { createHandler } from "./handler";
import { productionAdminServices } from "./admin";
import {
  cleanupModerationData,
  processModerationNotifications,
  reactivateExpiredSuspensions,
} from "./moderation";
import { releaseExpiredReservations } from "./quota";
import type { AppEnv } from "./types";

const handler = createHandler();

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    return handler(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: AppEnv): Promise<void> {
    await releaseExpiredReservations(env);
    await reactivateExpiredSuspensions(env);
    await processModerationNotifications(env, productionAdminServices);
    await cleanupModerationData(env);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_challenges WHERE expires_at < ?").bind(now - 86_400_000),
      env.DB.prepare("DELETE FROM authorization_codes WHERE expires_at < ?").bind(now - 86_400_000),
      env.DB.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").bind(now - 86_400_000),
      env.DB.prepare("DELETE FROM sessions WHERE absolute_expires_at < ? OR revoked_at < ?")
        .bind(now - 86_400_000, now - 30 * 86_400_000),
    ]);
  },
} satisfies ExportedHandler<AppEnv>;
