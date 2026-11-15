import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { composeDigest } from "../../../stacks/nest/digest.ts";
import { Digest } from "../../../stacks/nest/health.ts";

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
        failed: 0,
        fallbacks: 0,
        lost: 0,
        quarantined: 0,
        ratking: 0,
        raw: 0,
        sent: 0,
        unanswered: 0,
      };

      const result = composeDigest(
        health,
        counts,
        counts,
        "2026-01-01T00:00:00Z",
        { reasons, status }
      );

      expect(result.status).toBe(status);
      expect(result.reasons).toEqual(reasons);
    })
);
