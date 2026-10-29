import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tools/grokbox/test/**/*.test.ts"], testTimeout: 60_000 },
});
