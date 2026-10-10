import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
        test: {
          env: { ALCHEMY_TELEMETRY_DISABLED: "1" },
          exclude: [".agent_sources/**", "node_modules/**", ".fence-tmp/**"],
          include: ["tools/fence/**/*.test.ts"],
          name: "fence",
        },
      },
      {
        extends: "tools/lexgen/vitest.config.ts",
        test: { name: "lexgen" },
      },
      {
        extends: "packages/alchemy-nest/vitest.config.ts",
        test: {
          env: { ALCHEMY_TELEMETRY_DISABLED: "1" },
          name: "alchemy-nest",
        },
      },
      {
        extends: "stacks/cf/vitest.config.ts",
        test: {
          env: { ALCHEMY_TELEMETRY_DISABLED: "1" },
          name: "cf",
        },
      },
      {
        extends: "packages/mailbox-client/vitest.config.ts",
        test: { name: "mailbox-client" },
      },
      {
        extends: "packages/pi-ratking/vitest.config.ts",
        test: { name: "pi-ratking" },
      },
      {
        extends: "packages/envelope/vitest.config.ts",
        test: { name: "envelope" },
      },
      {
        extends: "apps/mailbox/vitest.config.ts",
        test: { name: "mailbox" },
      },
      {
        extends: "packages/agent-runtime/vitest.config.ts",
        test: { name: "agent-runtime" },
      },
      {
        extends: "apps/claude-sidecar/vitest.config.ts",
        test: { name: "claude-sidecar" },
      },
    ],
  },
});
