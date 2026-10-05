import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [".agent_sources/**", "node_modules/**"],
    include: ["tools/lexgen/**/*.test.ts"],
  },
});
