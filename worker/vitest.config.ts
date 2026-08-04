import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Unit tests inject their own Env bindings. Keep the test runtime fully local
  // so CI never needs production Cloudflare credentials or a remote AI session.
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
});
