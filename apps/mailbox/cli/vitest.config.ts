import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/mailbox/cli/test/send-body.test.ts"],
  },
});
