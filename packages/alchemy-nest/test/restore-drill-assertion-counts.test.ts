// @effect-diagnostics asyncFunction:off -- Exercise the standalone Promise fault projection.
import { it } from "@effect/vitest";
import { Arbitrary, Data, Effect, Schema } from "effect";
import { expect } from "vitest";

import { requireMailboxCounts } from "../../../stacks/nest/restore-drill-proof-assertion.ts";
import {
  proofFailureMetadata,
  runProofEffect,
} from "../../../stacks/nest/restore-drill-proof-errors.ts";

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: 100_000, minimum: 0 })
);

it.effect.prop(
  "exact count failures preserve assertion, expected, actual and zero-based mailbox position through real Effect causes",
  {
    delta: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
    events: Arbitrary.schema(Schema.Boolean),
    expected: Arbitrary.schema(Count),
    mailboxIndex: Arbitrary.schema(Count),
  },
  ({ expected, delta, mailboxIndex, events }) =>
    Effect.gen(function* countFailure() {
      const baseline = { events: expected, messages: expected };

      const changed = events
        ? { ...baseline, events: expected + delta }
        : { ...baseline, messages: expected + delta };

      expect(() => {
        requireMailboxCounts(baseline, baseline, mailboxIndex);
      }).not.toThrow();

      const metadata = yield* Effect.promise(
        async () =>
          await runProofEffect(
            Effect.sync(() => {
              requireMailboxCounts(baseline, changed, mailboxIndex);
            })
          ).then(
            () => proofFailureMetadata("primary", null),
            (error: unknown) =>
              proofFailureMetadata("primary", error, {
                lastOk: "fetch-events",
                step: "compare-counts",
              })
          )
      );

      expect(metadata).toMatchObject({
        actual: expected + delta,
        assertionCode: events
          ? "EVENT_COUNT_MISMATCH"
          : "MESSAGE_COUNT_MISMATCH",
        expected,
        lastOk: "fetch-events",
        mailboxIndex,
        phase: "primary",
        step: "compare-counts",
        tag: "ProofAssertionFailure",
      });
      expect(metadata.status).toBeUndefined();
    })
);

it.prop(
  "only safe nonnegative integers on assertion faults enter numeric metadata",
  {
    kind: Arbitrary.schema(
      Schema.Literals(["negative", "nan", "infinity", "fraction", "unsafe"])
    ),
    negative: Arbitrary.schema(Schema.Int.check(Schema.isLessThan(0))),
  },
  ({ kind, negative }) => {
    const value = {
      fraction: 0.5,
      infinity: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      negative,
      unsafe: Number.MAX_SAFE_INTEGER + 1,
    }[kind];

    const fault = Data.taggedEnum<{
      readonly _tag: "ProofAssertionFailure";
      readonly assertionCode: "MESSAGE_COUNT_MISMATCH";
      readonly expected: number;
      readonly actual: number;
      readonly mailboxIndex: number;
    }>().ProofAssertionFailure({
      actual: value,
      assertionCode: "MESSAGE_COUNT_MISMATCH",
      expected: value,
      mailboxIndex: value,
    });

    const metadata = proofFailureMetadata("primary", fault);

    expect(metadata.assertionCode).toBe("MESSAGE_COUNT_MISMATCH");
    expect(metadata.expected).toBeUndefined();
    expect(metadata.actual).toBeUndefined();
    expect(metadata.mailboxIndex).toBeUndefined();
  }
);

it.prop(
  "unrelated HTTP faults cannot attach count or index fields",
  {
    value: Arbitrary.schema(Count),
  },
  ({ value }) => {
    const fault = Data.taggedEnum<{
      readonly _tag: "ProofHttpFailure";
      readonly status: number;
      readonly expected: number;
      readonly actual: number;
      readonly mailboxIndex: number;
    }>().ProofHttpFailure({
      actual: value,
      expected: value,
      mailboxIndex: value,
      status: 409,
    });

    const metadata = proofFailureMetadata("primary", fault);

    expect(metadata.status).toBe(409);
    expect(metadata.expected).toBeUndefined();
    expect(metadata.actual).toBeUndefined();
    expect(metadata.mailboxIndex).toBeUndefined();
  }
);
