/* oxlint-disable typescript/promise-function-async, effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun bridges commands through the owning test context. */
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  createProofProgress,
  ProofAssertionFailure,
  withProofCleanup,
} from "../../../stacks/nest/restore-drill-proof-errors.ts";
import type {
  ProofFailure,
  ProofProgress,
} from "../../../stacks/nest/restore-drill-proof-errors.ts";

interface ProgressModel {
  lastOk: ProofProgress["lastOk"];
  step: ProofProgress["step"];
}

it.effect.prop(
  "step receipts precede work, lastOk advances only after success and primary snapshots survive cleanup progress",
  {
    at: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 }))
    ),
    steps: Arbitrary.schema(
      Schema.Array(
        Schema.Literals([
          "reload",
          "resolve-name",
          "fetch-events",
          "compare-counts",
        ])
      ).check(Schema.isMinLength(1), Schema.isMaxLength(6))
    ),
  },
  ({ at, steps }) =>
    Effect.gen(function* progressModel() {
      const context = yield* Effect.context();
      const run = Effect.runPromiseWith(context);
      const failedIndex = at % steps.length;
      const history: ProofProgress[] = [];

      const tracker = createProofProgress((state) =>
        Effect.sync(() => {
          history.push({ ...state });
        })
      );

      const model: ProgressModel = { lastOk: "none", step: "bootstrap" };

      const commands: AsyncCommand<ProgressModel, typeof tracker>[] = steps
        .slice(0, failedIndex + 1)
        .map((step, index) => ({
          check: () => true,
          run: (expected: ProgressModel, real: typeof tracker) =>
            run(
              Effect.gen(function* progressCommand() {
                const before = history.length;
                const failed = index === failedIndex;

                const work = Effect.suspend(() => {
                  expect(history.at(-1)).toEqual(real.snapshot());

                  return failed
                    ? Effect.fail(
                        new ProofAssertionFailure({
                          assertionCode: "EVENT_COUNT_MISMATCH",
                        })
                      )
                    : Effect.void;
                });

                if (failed) {
                  const failures: ProofFailure[] = [];

                  yield* withProofCleanup(
                    real.run(step, work),
                    real.run("restore-auth", Effect.void),
                    (failure) =>
                      Effect.sync(() => {
                        failures.push(failure);
                      }),
                    real.snapshot
                  ).pipe(Effect.ignore);
                  expect(failures).toHaveLength(1);
                  expect(failures[0]).toMatchObject({
                    assertionCode: "EVENT_COUNT_MISMATCH",
                    code: "EFFECT_FAIL",
                    lastOk: expected.lastOk,
                    phase: "primary",
                    step,
                  });
                  expected.lastOk = "restore-auth";
                  expected.step = "restore-auth";
                } else {
                  yield* real.run(step, work);
                  expected.lastOk = step;
                  expected.step = step;
                }

                expect(real.snapshot()).toEqual(expected);
                expect(history).toHaveLength(before + (failed ? 3 : 2));
              })
            ),
          toString: () => `ProofStep:${step}`,
        }));

      yield* Effect.promise(() =>
        asyncModelRun(() => ({ model, real: tracker }), commands)
      );
    })
);
