import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/agent-runtime/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
