// @effect-diagnostics asyncFunction:off -- fast-check commands drive the standalone Promise progress adapter.
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  createProofProgress,
  ProofAssertionFailure,
  runProofEffect,
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
      const failedIndex = at % steps.length;
      const history: ProofProgress[] = [];

      const tracker = createProofProgress(async (state) => {
        await Promise.resolve(history.push({ ...state }));
      });

      const model: ProgressModel = { lastOk: "none", step: "bootstrap" };

      const commands: AsyncCommand<ProgressModel, typeof tracker>[] = steps
        .slice(0, failedIndex + 1)
        .map((step, index) => ({
          check: () => true,
          run: async (expected: ProgressModel, real: typeof tracker) => {
            const before = history.length;
            const failed = index === failedIndex;

            const work = async () => {
              expect(history.at(-1)).toEqual(real.snapshot());
              await runProofEffect(
                failed
                  ? Effect.fail(
                      new ProofAssertionFailure({
                        assertionCode: "EVENT_COUNT_MISMATCH",
                      })
                    )
                  : Effect.void
              );
            };

            if (failed) {
              const failures: ProofFailure[] = [];

              await withProofCleanup(
                async () => {
                  await real.run(step, work);
                },
                async () => {
                  await real.run("restore-auth", () => null);
                },
                async (failure) => {
                  await Promise.resolve(failures.push(failure));
                },
                real.snapshot
              ).catch(() => null);
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
              await real.run(step, work);
              expected.lastOk = step;
              expected.step = step;
            }

            expect(real.snapshot()).toEqual(expected);
            expect(history).toHaveLength(before + (failed ? 3 : 2));
          },
          toString: () => `ProofStep:${step}`,
        }));

      yield* Effect.promise(async () => {
        await asyncModelRun(() => ({ model, real: tracker }), commands);
      });
    })
);
