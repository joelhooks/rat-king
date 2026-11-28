import { it } from "@effect/vitest";
import { Effect, Option, Random, Schema } from "effect";
import { expect } from "vitest";

import {
  HeldVerdict,
  judgeHeld,
  parkedRetryDelay,
  readerRetryDelay,
  successionRetryDelay,
  UNIDENTIFIED,
} from "../src/lease-recovery.ts";
import { epoch, id, integer, iso } from "./client-rule-inputs.ts";

const jitter = integer(0, 2000);

const judgment = (
  now: number,
  jitterMs: number,
  holder?: { expiresAt: string; session: string },
  heldFor = 0
) =>
  judgeHeld({
    heldFor,
    holder: Option.fromNullishOr(holder),
    jitterMs,
    now,
    session: "self",
  });

const own = (at: number) => ({ expiresAt: iso(at), session: "self" });

it.prop(
  "without a holder, retry uses the entire supplied jitter and no expiry budget",
  [epoch, jitter, id],
  ([now, spread, heldFor]) => {
    expect(judgment(now, spread, undefined, heldFor)).toEqual(
      HeldVerdict.Wait({ delayMs: spread })
    );
  }
);

it.prop(
  "a known foreign holder parks until its exact expiry, then retries",
  [epoch, id, jitter],
  ([expiry, who, spread]) => {
    const session = `other-${who}`;
    const holder = { expiresAt: iso(expiry), session };
    expect(judgment(expiry - 1, spread, holder)).toEqual(
      HeldVerdict.Park({ holder: session })
    );
    expect(judgment(expiry, spread, holder)).toEqual(
      HeldVerdict.Wait({ delayMs: Math.max(1, spread) })
    );
  }
);

it.prop(
  "a self-held lease never parks even when its expiry extends past a TTL",
  [epoch, jitter, id],
  ([now, spread, extra]) => {
    expect(
      judgment(now, spread, own(now + 300_000 + extra), 300_000 + extra)._tag
    ).toBe("Wait");
  }
);

it.prop(
  "an unidentified expired holder is never parked even after the ordinary wait limit",
  [epoch, id, jitter],
  ([now, ago, spread]) => {
    const holder = { expiresAt: iso(now - ago), session: UNIDENTIFIED };
    expect(judgment(now, spread, holder, 300_000 + ago)._tag).toBe("Wait");
  }
);

it.prop(
  "time since expiry consumes jitter before the delay floor applies",
  [epoch, integer(1, 1000), integer(2, 1000)],
  ([now, ago, unspent]) => {
    expect(judgment(now, ago + unspent, own(now - ago))).toEqual(
      HeldVerdict.Wait({ delayMs: unspent })
    );
  }
);

it.prop(
  "recently expired leases clamp their delay to a positive millisecond, not a zero-delay spin",
  [epoch, id],
  ([now, ago]) => {
    expect(judgment(now, 0, own(now - ago))).toEqual(
      HeldVerdict.Wait({ delayMs: 1 })
    );
  }
);

it.prop(
  "before the held delay ceiling, increasing remaining time increases retry delay one-for-one",
  [epoch, integer(1, 7999), jitter],
  ([now, remaining, spread]) => {
    expect(judgment(now, spread, own(now + remaining))).toEqual(
      HeldVerdict.Wait({ delayMs: remaining + spread })
    );
    expect(judgment(now, spread, own(now + remaining + 1))).toEqual(
      HeldVerdict.Wait({ delayMs: remaining + spread + 1 })
    );
  }
);

it.prop(
  "a far-away expiry cannot exceed eight seconds plus the injected jitter",
  [epoch, integer(8001, 900_000), jitter],
  ([now, remaining, spread]) => {
    expect(judgment(now, spread, own(now + remaining))).toEqual(
      HeldVerdict.Wait({ delayMs: 8000 + spread })
    );
  }
);

it.effect.prop(
  "the first three seeded retry windows grow geometrically before the ceiling",
  [Schema.String],
  ([seed]) =>
    Effect.gen(function* firstRetries() {
      const first = yield* readerRetryDelay(0).pipe(Random.withSeed(seed));
      const second = yield* readerRetryDelay(1).pipe(Random.withSeed(seed));
      const third = yield* readerRetryDelay(2).pipe(Random.withSeed(seed));
      expect(second).toBeCloseTo(first * 2, 9);
      expect(third).toBeCloseTo(first * 4, 9);
      expect(first).toBeLessThan(1000);
    })
);

it.effect.prop(
  "late reader retries saturate to the same seeded window as a succession retry",
  [Schema.String, integer(3, 400)],
  ([seed, attempt]) =>
    Effect.gen(function* cappedRetries() {
      const current = yield* readerRetryDelay(attempt).pipe(
        Random.withSeed(seed)
      );

      const successor = yield* successionRetryDelay.pipe(Random.withSeed(seed));
      expect(current).toBe(successor);
    })
);

it.effect.prop(
  "parked leases retry in whole milliseconds within the slower jitter window",
  [Schema.String],
  ([seed]) =>
    Effect.gen(function* parkedWindow() {
      const delay = yield* parkedRetryDelay.pipe(Random.withSeed(seed));
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(30_000);
      expect(delay).toBeLessThanOrEqual(35_000);
    })
);
