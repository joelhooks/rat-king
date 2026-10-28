import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["stacks/cf/*.test.ts", "tools/cf-measure/*.test.ts"],
    testTimeout: 120_000,
  },
});
