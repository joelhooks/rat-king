import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/claude-sidecar/test/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
