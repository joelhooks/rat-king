import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/alchemy-nest/test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
