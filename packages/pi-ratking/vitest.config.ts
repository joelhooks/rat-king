import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/pi-ratking/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
