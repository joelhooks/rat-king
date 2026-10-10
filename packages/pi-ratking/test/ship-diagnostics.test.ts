import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { initialTransition } from "xstate";

import { execute } from "../../../stacks/nest/ship-command.ts";
import type { ShipReceipt } from "../../../stacks/nest/ship-config.ts";
import { sanitizeCandidateStderr } from "../../../stacks/nest/ship-diagnostics.ts";
import { shipMachine } from "../../../stacks/nest/ship-machine.ts";
import { shipCycle } from "../../../stacks/nest/ship.ts";

it.effect.prop(
  "failed candidate stderr keeps the public cause while withholding arbitrary secrets, schema inputs, paths and transcripts",
  [Schema.String],
  ([noise]) =>
    Effect.gen(function* diagnostics() {
      const secret = "invented-private-value.invalid";
      const raw = `${noise}\nHostError: Only a matching file may be adopted. secret=${secret}\n at RemoteFile.provider.read (file:///private/instance.invalid/file.ts:4)\n`;

      const result = yield* execute(
        process.execPath,
        [
          "-e",
          `process.stderr.write(${JSON.stringify(raw)});process.exitCode=1`,
        ],
        process.cwd()
      ).pipe(Effect.provide(NodeServices.layer));

      expect(result.code).toBe(1);
      expect(result.stderrTail).toContain(
        "Only a matching file may be adopted"
      );
      expect(result.stderrTail).toContain("RemoteFile.provider.read");
      expect(result.stderrTail).not.toContain(secret);
      expect(result.stderrTail).not.toContain("file:///");
      expect(sanitizeCandidateStderr(`SchemaError: ${secret}`)).toBe(
        "Candidate stderr withheld: unrecognized diagnostic"
      );
      expect(result.stderrTail?.length).toBeLessThanOrEqual(2048);
      const receipts: (typeof ShipReceipt.Type)[] = [];

      const [initial] = initialTransition(shipMachine, {
        failed: "",
        successful: "",
      });

      yield* shipCycle(initial, {
        checkpoint: () => Effect.void,
        ci: () => Effect.succeed(true),
        deploy: () =>
          Effect.succeed({
            celldRestarted: false,
            restartSeconds: 0,
            result: "failed" as const,
            stderrTail: result.stderrTail ?? "",
          }),
        fetch: Effect.succeed("a".repeat(40)),
        notify: () => Effect.void,
        record: (receipt) =>
          Effect.sync(() => {
            receipts.push(receipt);
          }),
      });
      expect(receipts[0]?.stderrTail).toBe(result.stderrTail);
    })
);
