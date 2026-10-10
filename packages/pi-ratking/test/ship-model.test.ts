/* oxlint-disable typescript/promise-function-async -- fast-check commands and asyncModelRun are Promise boundaries. */
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";
import { initialTransition } from "xstate";

import { shipMachine } from "../../../stacks/nest/ship-machine.ts";
import { shipCycle } from "../../../stacks/nest/ship.ts";
import type { ShipPorts, ShipSnapshot } from "../../../stacks/nest/ship.ts";

const Cycle = Schema.Struct({
  ci: Schema.Boolean,
  outcome: Schema.Literals(["success", "failed", "deferred"]),
  sha: Schema.Literals(["a".repeat(40), "b".repeat(40), "c".repeat(40)]),
});

interface Model {
  failed: string;
  successful: string;
}

interface Real {
  checkpoint: Model;
  deployed: number;
  notes: number;
  receipts: number;
  snapshot: ShipSnapshot;
}

class ModelFailure extends Schema.TaggedError<ModelFailure>()("ModelFailure", {
  reason: Schema.String,
}) {}

it.effect.prop(
  "ship serializes deploys, retries busy maintenance and holds a failed SHA until a new SHA",
  [Schema.Array(Cycle)],
  ([cycles]) =>
    Effect.gen(function* modelRun() {
      const context = yield* Effect.context();

      const command = (
        cycle: typeof Cycle.Type
      ): AsyncCommand<Model, Real> => ({
        check: () => true,
        run: (model, real) => {
          const operation = Effect.gen(function* cycleCommand() {
            const before = real.deployed;

            const eligible =
              cycle.ci &&
              cycle.sha !== model.successful &&
              cycle.sha !== model.failed;

            const ports: ShipPorts = {
              checkpoint: (next) =>
                Effect.sync(() => {
                  real.checkpoint = {
                    failed: next.failed,
                    successful: next.successful,
                  };
                }),
              ci: () => Effect.succeed(cycle.ci),
              deploy: () =>
                Effect.sync(() => {
                  expect(real.checkpoint.failed).toBe(cycle.sha);
                  real.deployed += 1;

                  return {
                    celldRestarted: false,
                    restartSeconds: 0,
                    result: cycle.outcome,
                  };
                }),
              fetch: Effect.succeed(cycle.sha),
              notify: () =>
                Effect.sync(() => {
                  real.notes += 1;
                }),
              record: () =>
                Effect.sync(() => {
                  real.receipts += 1;
                }),
            };

            real.snapshot = yield* shipCycle(real.snapshot, ports);

            if (eligible && cycle.outcome === "success") {
              model.successful = cycle.sha;
              model.failed = "";
            }

            if (eligible && cycle.outcome === "failed") {
              model.failed = cycle.sha;
            }

            expect(real.deployed - before).toBe(eligible ? 1 : 0);
            expect(real.snapshot.context.successful).toBe(model.successful);
            expect(real.snapshot.context.failed).toBe(model.failed);
            expect(real.checkpoint).toEqual(model);
            expect(real.receipts).toBe(real.deployed);
            expect(real.notes).toBe(real.deployed);
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun needs a Promise per command; reuse the test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(cycle),
      });

      const [snapshot] = initialTransition(shipMachine, {
        failed: "",
        successful: "",
      });

      yield* Effect.tryPromise({
        catch: () => new ModelFailure({ reason: "Ship model diverged" }),
        try: () =>
          asyncModelRun(
            () => ({
              model: { failed: "", successful: "" },
              real: {
                checkpoint: { failed: "", successful: "" },
                deployed: 0,
                notes: 0,
                receipts: 0,
                snapshot,
              },
            }),
            cycles.map(command)
          ),
      });
    })
);
