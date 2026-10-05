import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    include: ["apps/mailbox/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
