import { it } from "@effect/vitest";
import { Arbitrary, Duration, Schema } from "effect";
import { expect } from "vitest";

import {
  healthWait,
  packLimit,
  precopyLimit,
  settleDelay,
  snapshotLimit,
} from "../../../stacks/nest/backup.ts";

const gib = 1_073_741_824;

const bytes = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 200 * gib, minimum: 0 }))
);

it.prop(
  "pack has a 45-minute floor, grows above 40 GiB, and leaves preparation room inside four hours through 200 GiB",
  { a: bytes, b: bytes },
  ({ a, b }) => {
    const smaller = Math.min(a, b);
    const larger = Math.max(a, b);
    const floor = Duration.toMillis(Duration.minutes(45));
    const low = Duration.toMillis(packLimit(smaller));
    const high = Duration.toMillis(packLimit(larger));

    expect(low).toBeGreaterThanOrEqual(floor);
    expect(high).toBeGreaterThanOrEqual(low);
    expect(Duration.toMillis(packLimit(Math.min(a, 40 * gib)))).toBe(floor);
    expect(
      Duration.toMillis(packLimit(Math.max(a, 40 * gib) + gib))
    ).toBeGreaterThan(Duration.toMillis(packLimit(Math.max(a, 40 * gib))));

    const preparation = [
      precopyLimit,
      snapshotLimit,
      healthWait,
      settleDelay,
      Duration.minutes(10),
    ].reduce((total, limit) => total + Duration.toMillis(limit), 0);

    expect(Duration.toMillis(packLimit(200 * gib)) + preparation).toBeLessThan(
      Duration.toMillis(Duration.hours(4))
    );
  }
);
