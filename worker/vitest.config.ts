import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  // Unit tests inject their own Env bindings. Keep the test runtime fully local
  // so CI never needs production Cloudflare credentials or a remote AI session.
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
});
