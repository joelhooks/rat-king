import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { composeDigest } from "../../../stacks/nest/digest.ts";
import {
  Digest,
  doctorUnavailableSummary,
} from "../../../stacks/nest/health.ts";

it.prop(
  "doctor digest counts new readings, handles resets and stays silent without new readings",
  [
    Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 0 })),
    Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 0 })),
    Schema.String,
  ],
  ([current, previous, reason]) => {
    const expected = current < previous ? current : current - previous;
    expect(doctorUnavailableSummary(current, previous, reason)).toEqual(
      expected === 0
        ? []
        : [
            `Configuration doctor unavailable: ${expected} readings since previous digest; last reason: ${reason}`,
          ]
    );
    expect(doctorUnavailableSummary(current, current, reason)).toEqual([]);

    if (current > 0) {
      expect(
        doctorUnavailableSummary(current, current + 1, reason)[0]
      ).toContain(`${current} readings`);
    }
  }
);

const Healthy = Schema.Struct({
  ...Digest.fields,
  reasons: Schema.Array(Schema.Never),
  status: Schema.Literal("ok"),
});

it.effect.prop(
  "config doctor outcomes set an otherwise healthy fleet digest and preserve every reason",
  [
    Healthy,
    Schema.Array(Schema.String),
    Schema.Literals(["ok", "warn", "fail"]),
  ],
  ([health, reasons, status]) =>
    Effect.sync(() => {
      const counts = {
        fallbacks: 0,
        lost: 0,
        quarantined: 0,
        sent: 0,
      };

      const result = composeDigest(health, counts, "2026-01-01T00:00:00Z", {
        reasons,
        status,
      });

      expect(result.status).toBe(status);
      expect(result.reasons).toEqual(reasons);
    })
);
