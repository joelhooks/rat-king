import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { announceRestart } from "../../../stacks/nest/ship-notice.ts";

it.effect.prop(
  "a restart announces once and cannot proceed before its notice delay",
  [Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 }))],
  ([seconds]) =>
    Effect.gen(function* delay() {
      const done = yield* Ref.make(false);
      const notes = yield* Ref.make<readonly string[]>([]);

      const attempt = {
        events: "/tmp/events.invalid",
        restart: {
          lock: "/tmp/lock.invalid",
          marker: "/tmp/marker.invalid",
          noticeSeconds: seconds,
          unit: "cell.invalid.service",
          units: ["maintenance.invalid.service"] as const,
        },
        sha: "a".repeat(40),
      };

      const child = yield* Effect.forkChild(
        announceRestart(attempt, (text) =>
          Ref.update(notes, (values) => [...values, text])
        ).pipe(Effect.andThen(Ref.set(done, true)))
      );

      yield* TestClock.adjust(Duration.seconds(seconds - 1));
      expect(yield* Ref.get(done)).toBe(false);
      expect(yield* Ref.get(notes)).toHaveLength(1);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(child);
      expect(yield* Ref.get(done)).toBe(true);
      expect((yield* Ref.get(notes))[0]).toContain(
        `celld restart in ~${seconds} s for ${attempt.sha.slice(0, 12)}`
      );
    })
);
