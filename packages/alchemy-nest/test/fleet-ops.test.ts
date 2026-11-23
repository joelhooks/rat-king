import { it } from "@effect/vitest";
import { Effect, Match, Schema, Stream } from "effect";
import { expect } from "vitest";

import { countFrames, doneBar } from "../../../stacks/nest/comms.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";

it.prop(
  "stage config rejects missing fields, unknown settings and invalid stage or boolean values",
  [StageConfig, Schema.Literals(["missing", "unknown", "stage", "boolean"])],
  ([config, mutation]) => {
    const runtime = { ...config.runtime };

    const candidate = Match.value(mutation).pipe(
      Match.when("missing", () => ({ ...config, runtime: {} })),
      Match.when("unknown", () => ({
        ...config,
        runtime: { ...runtime, UNDECLARED: "fixture.invalid" },
      })),
      Match.when("stage", () => ({
        ...config,
        runtime: { ...runtime, RAT_KING_STAGE: "fixture.invalid" },
      })),
      Match.when("boolean", () => ({
        ...config,
        runtime: { ...runtime, RAT_KING_CLAUDE_SIDECAR: "false" },
      })),
      Match.exhaustive
    );

    expect(
      Schema.decodeUnknownOption(StageConfig)(candidate, {
        onExcessProperty: "error",
      })._tag
    ).toBe("None");
  }
);

const Route = Schema.Struct({
  failed: Schema.Boolean,
  fallback: Schema.Boolean,
  recent: Schema.Boolean,
});

it.effect.prop(
  "comms counts recent route receipts, fallback losses and quarantine",
  [
    Schema.Array(Route),
    Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })),
    Schema.Boolean,
  ],
  ([routes, quarantined, reverse]) =>
    Effect.gen(function* receiptCounts() {
      const frames = [
        ...routes.map((route) => ({
          kind: "receipt" as const,
          line: JSON.stringify({
            at: route.recent ? "2026-10-10T01:00:00Z" : "2026-10-08T01:00:00Z",
            fallback: { status: route.failed ? "failed" : "delivered" },
            path: route.fallback ? "intercom-fallback" : "network",
          }),
        })),
        ...Array.from({ length: quarantined }, () => ({
          kind: "quarantine" as const,
        })),
      ];

      const counts = yield* countFrames(
        Stream.fromIterable(reverse ? frames.toReversed() : frames),
        Date.parse("2026-10-09T01:00:00Z")
      );

      const recent = routes.filter((route) => route.recent);

      expect(counts).toEqual({
        fallbacks: recent.filter((route) => route.fallback).length,
        lost: recent.filter((route) => route.fallback && route.failed).length,
        quarantined,
        sent: recent.length,
      });
    })
);

const Loss = Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 }));

it.prop(
  "done-bar passes only with zero receipt losses on configured hosts",
  [Loss, Schema.NullOr(Loss)],
  ([local, remote]) => {
    const other = { fallbacks: 3, quarantined: 2, sent: 50 };

    expect(
      doneBar(
        { ...other, lost: local },
        remote === null ? null : { ...other, lost: remote }
      )
    ).toBe(local === 0 && (remote === null || remote === 0));
  }
);
