import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Random, Schema } from "effect";
import { expect } from "vitest";

import {
  judgeHeld,
  LEASE_TTL_MS,
  readerRetryDelay,
  successionRetryDelay,
  UNIDENTIFIED,
} from "../src/lease-recovery.ts";

it.effect.prop(
  "reader supervision spreads first retries and retains its five-second ceiling",
  [
    Schema.String,
    Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
    Schema.Boolean,
  ],
  ([seed, attempt, successor]) =>
    Effect.gen(function* proof() {
      const window = successor
        ? 5000
        : Math.min(5000, 1000 * 2 ** Math.min(attempt, 5));

      const delays = yield* Effect.forEach(Array.from({ length: 64 }), () =>
        successor ? successionRetryDelay : readerRetryDelay(attempt)
      );

      expect(delays.every((delay) => delay >= 0 && delay < window)).toBe(true);
      expect(Math.min(...delays)).toBeLessThan(window * 0.25);
      expect(Math.max(...delays)).toBeGreaterThan(window * 0.75);
    }).pipe(Random.withSeed(seed))
);

it.prop(
  "an unidentified holder is waited out for one TTL and then parked, never sooner",
  [
    Schema.Int.check(
      Schema.isBetween({ maximum: 2 * LEASE_TTL_MS, minimum: 0 })
    ),
    Schema.Int.check(Schema.isBetween({ maximum: LEASE_TTL_MS, minimum: 1 })),
  ],
  ([heldFor, ahead]) => {
    const verdict = judgeHeld({
      heldFor,
      holder: Option.some({
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(1_000_000 + ahead)),
        session: UNIDENTIFIED,
      }),
      jitterMs: 0,
      now: 1_000_000,
      session: "me",
    });

    expect(verdict._tag).toBe(heldFor < LEASE_TTL_MS ? "Wait" : "Park");
  }
);
