// @effect-diagnostics asyncFunction:off -- Fault-injected Promise ports for the standalone proof subprocess.
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { scrubChild } from "../../../stacks/nest/restore-drill-diagnostics.ts";
import {
  ProofHttpFailure,
  proofFailureMetadata,
  withProofCleanup,
} from "../../../stacks/nest/restore-drill-proof-errors.ts";
import type { ProofFailure } from "../../../stacks/nest/restore-drill-proof-errors.ts";

it.effect.prop(
  "proof cleanup runs once and cannot replace a primary failure, even when reporting fails",
  {
    cleanupFails: Arbitrary.schema(Schema.Boolean),
    reportFails: Arbitrary.schema(Schema.Boolean),
    workFails: Arbitrary.schema(Schema.Boolean),
  },
  ({ cleanupFails, reportFails, workFails }) =>
    Effect.gen(function* proofCleanup() {
      const primary = new ProofHttpFailure({ status: 503 });
      const secondary = new ProofHttpFailure({ status: 500 });
      const reports: ProofFailure[] = [];
      const events: string[] = [];

      const outcome = yield* Effect.promise(
        async () =>
          await withProofCleanup(
            async () => {
              events.push("work");

              return await (workFails
                ? Promise.reject(primary)
                : Promise.resolve(7));
            },
            async () => {
              events.push("cleanup");

              await (cleanupFails
                ? Promise.reject(secondary)
                : Promise.resolve());
            },
            async (failure) => {
              reports.push(failure);
              events.push(`report-${failure.phase}`);

              await (reportFails
                ? Promise.reject(new Error("report unavailable"))
                : Promise.resolve());
            }
          ).then(
            (value) => ({ error: undefined, value }),
            (error: unknown) => ({ error, value: undefined })
          )
      );

      let expected: Error | undefined;

      if (workFails) {
        expected = primary;
      } else if (cleanupFails) {
        expected = secondary;
      }

      expect(outcome.error).toBe(expected);
      expect(events).toEqual([
        "work",
        ...(workFails ? ["report-primary"] : []),
        "cleanup",
        ...(cleanupFails ? ["report-cleanup"] : []),
      ]);
      expect(reports.map((failure) => failure.status)).toEqual([
        ...(workFails ? [503] : []),
        ...(cleanupFails ? [500] : []),
      ]);

      if (expected === undefined) {
        expect(outcome.value).toBe(7);
      }
    })
);

it.prop(
  "weed events and proof errors retain fixed classifications, never arbitrary payload or request fields",
  {
    event: Arbitrary.schema(
      Schema.Literals([
        "no free volumes",
        "no writable volumes",
        "assign",
        "grow",
        "readonly",
        "disk",
      ])
    ),
    nonce: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 1 }))
    ),
  },
  ({ event, nonce }) => {
    const sensitive = `PRIVATE_PROOF_VALUE_${nonce}`;

    const error = Object.assign(new ProofHttpFailure({ status: 500 }), {
      reason: sensitive,
      request: sensitive,
    });

    error.name = sensitive;

    const metadata = proofFailureMetadata("primary", error);

    const diagnostic = scrubChild(
      {
        argv: ["weed"],
        env: {},
        name: "weed",
        stderr: `${event} payload=${sensitive}`,
        stdout: "",
      },
      null
    );

    expect(metadata.status).toBe(500);
    expect(metadata.phase).toBe("primary");
    expect(metadata.errorKind).toBe("Unknown");
    expect(diagnostic.stderr).toContain("[diagnostic:");
    expect(JSON.stringify({ diagnostic, metadata })).not.toContain(sensitive);
  }
);
