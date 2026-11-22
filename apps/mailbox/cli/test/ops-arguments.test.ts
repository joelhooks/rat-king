import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { runCommand } from "../../../../packages/ratking-client/src/process.ts";

it.effect(
  "unknown mailbox and nest flags exit nonzero before executing the action",
  () =>
    Effect.gen(function* check() {
      const mailbox = yield* runCommand([
        process.execPath,
        "apps/mailbox/cli/main.ts",
        "register",
        "--did",
        "did:web:example.invalid",
        "--unsupported-fixture",
      ]);

      const nest = yield* runCommand([
        process.execPath,
        "stacks/nest/cli.ts",
        "ops-digest",
        "--unsupported-fixture",
      ]);

      expect(mailbox.code).toBe(2);
      expect(mailbox.stdout).toContain("mailbox register [flags]");
      expect(nest.code).not.toBe(0);
      expect(nest.stdout).not.toContain("Ops reading unavailable");
    }).pipe(Effect.provide(NodeServices.layer))
);
