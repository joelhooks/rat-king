import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        extends: "tools/grokbox/vitest.config.ts",
        test: { name: "grokbox" },
      },
      {
        extends: "apps/ratking-sh/vitest.config.ts",
        test: { env: { ALCHEMY_TELEMETRY_DISABLED: "1" }, name: "ratking-sh" },
      },
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
        extends: false,
        test: {
          include: ["packages/lexicon/test/pass*.test.ts"],
          name: "lexicon-passes",
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
        extends: "apps/billing-ingress/vitest.config.ts",
        test: { env: { ALCHEMY_TELEMETRY_DISABLED: "1" }, name: "billing" },
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
        extends: "packages/ratking-client/vitest.config.ts",
        test: { name: "ratking-client" },
      },
      {
        extends: "apps/ratking-mcp/vitest.config.ts",
        test: { name: "ratking-mcp" },
      },
      {
        extends: "apps/ratking-cli/vitest.config.ts",
        test: { name: "ratking-cli" },
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
        extends: "packages/remembers/vitest.config.ts",
        test: { name: "remembers" },
      },
      {
        extends: "packages/remembers-host/vitest.config.ts",
        test: { name: "remembers-host" },
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
