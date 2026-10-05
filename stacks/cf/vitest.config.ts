import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["stacks/cf/*.test.ts"], testTimeout: 120_000 },
});
