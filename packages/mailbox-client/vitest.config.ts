import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    include: [
      "apps/mailbox/cli/test/**/*.test.ts",
      "packages/mailbox-client/test/**/*.test.ts",
    ],
    testTimeout: 120_000,
  },
});
