import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/ratking-mcp/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
