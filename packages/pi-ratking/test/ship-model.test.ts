/* oxlint-disable typescript/promise-function-async -- fast-check commands and asyncModelRun are Promise boundaries. */
import { it } from "@effect/vitest";
import { Clock, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";
import { initialTransition } from "xstate";

import { shipMachine } from "../../../stacks/nest/ship-machine.ts";
import { shipCycle, shipLoop } from "../../../stacks/nest/ship.ts";
import type { ShipPorts, ShipSnapshot } from "../../../stacks/nest/ship.ts";

const Cycle = Schema.Struct({
  ci: Schema.Boolean,
  elapsed: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
  outcome: Schema.Literals(["success", "failed", "deferred"]),
  sha: Schema.Literals(["a".repeat(40), "b".repeat(40), "c".repeat(40)]),
});

interface Model {
  deferred: string;
  failed: string;
  retryAt: number;
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
            yield* TestClock.adjust(Duration.seconds(cycle.elapsed));
            const now = (yield* Clock.currentTimeMillis) / 1000;
            const before = real.deployed;

            const eligible =
              cycle.ci &&
              cycle.sha !== model.successful &&
              cycle.sha !== model.failed &&
              (cycle.sha !== model.deferred || now >= model.retryAt);

            if (
              cycle.sha !== model.failed &&
              cycle.sha !== model.successful &&
              (cycle.sha !== model.deferred || now >= model.retryAt)
            ) {
              model.deferred = "";
              model.retryAt = 0;
            }

            const ports: ShipPorts = {
              checkpoint: (next) =>
                Effect.sync(() => {
                  real.checkpoint = {
                    deferred: next.deferred ?? "",
                    failed: next.failed,
                    retryAt: next.retryAt ?? 0,
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
                    retryAt: now + 90,
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

            if (eligible) {
              model.deferred = cycle.outcome === "deferred" ? cycle.sha : "";
              model.retryAt = cycle.outcome === "deferred" ? now + 90 : 0;
            }

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
            expect(real.snapshot.context.deferred).toBe(model.deferred);
            expect(real.snapshot.context.retryAt).toBe(model.retryAt);
            expect(real.checkpoint.failed).toBe(model.failed);
            expect(real.checkpoint.successful).toBe(model.successful);

            if (eligible) {
              expect(real.checkpoint).toEqual(model);
            }

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
              model: { deferred: "", failed: "", retryAt: 0, successful: "" },
              real: {
                checkpoint: {
                  deferred: "",
                  failed: "",
                  retryAt: 0,
                  successful: "",
                },
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

it.live.prop(
  "the ship loop runs until its own code changes and then exits, never before",
  [Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 }))],
  ([changesAt]) =>
    Effect.gen(function* runnerDriftProof() {
      let cycles = 0;
      let fetches = 0;
      const sha = "a".repeat(40);

      const ports: ShipPorts = {
        checkpoint: () => Effect.void,
        ci: () => Effect.succeed(true),
        deploy: () =>
          Effect.succeed({
            celldRestarted: false,
            restartSeconds: 0,
            result: "success",
          }),
        fetch: Effect.sync(() => {
          fetches += 1;

          return sha;
        }),
        notify: () => Effect.void,
        record: () => Effect.void,
      };

      yield* shipLoop(
        ports,
        { failed: "", successful: sha },
        0,
        Effect.sync(() => {
          cycles += 1;

          return cycles >= changesAt;
        })
      );

      expect(cycles).toBe(changesAt);
      expect(fetches).toBe(changesAt);
    }),
  { timeout: 30_000 }
);
