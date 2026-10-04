import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [".agent_sources/**", "node_modules/**", ".fence-tmp/**"],
    include: ["tools/fence/**/*.test.ts"],
  },
});
