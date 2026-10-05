import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/envelope/test/**/*.test.ts"] },
});
