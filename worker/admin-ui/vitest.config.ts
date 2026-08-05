import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["admin-ui/src/**/*.test.ts"],
  },
});
