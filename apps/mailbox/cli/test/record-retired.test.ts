import { it } from "@effect/vitest";
import { Arbitrary, Clock, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { recordRetiredFile } from "../record-retired.ts";

it.effect.prop(
  "a names file preserves order in bounded batches and pauses only between calls",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
    ),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 220, minimum: 0 }))
    ),
  ],
  ([size, count]) =>
    Effect.gen(function* proof() {
      const names = Array.from(
        { length: count },
        (_, index) => `example/name-${index}`
      );

      const calls: { names: readonly string[]; at: number }[] = [];

      const fiber = yield* recordRetiredFile(
        `\r\n${names.join("\r\n")}\r\n`,
        size,
        10,
        (batch) =>
          Effect.gen(function* call() {
            calls.push({ at: yield* Clock.currentTimeMillis, names: batch });
          })
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust(3000);
      yield* Fiber.join(fiber);
      expect(calls.flatMap((call) => call.names)).toEqual(names);
      expect(calls.every((call) => call.names.length <= size)).toBe(true);
      expect(calls.map((call) => call.at)).toEqual(
        calls.map((_, index) => index * 10)
      );
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "invalid batch controls or a bad name anywhere in the file cause no calls",
  [Arbitrary.schema(Schema.Literals(["size", "pause", "name"]))],
  ([bad]) =>
    Effect.gen(function* proof() {
      let calls = 0;

      const refused = yield* recordRetiredFile(
        bad === "name" ? `alpha\n${"x".repeat(129)}` : "alpha\nbeta",
        bad === "size" ? 101 : 1,
        bad === "pause" ? 0 : 10,
        () =>
          Effect.sync(() => {
            calls += 1;
          })
      ).pipe(Effect.flip);

      expect(refused.reason).toBeTruthy();
      expect(calls).toBe(0);
    })
);
