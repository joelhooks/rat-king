import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  READER_RECOVERY_GRACE_MS,
  readerSweepWindows,
  updateReaderWindows,
} from "../../../stacks/nest/alarm-reader-windows.ts";
import type { ReaderWindowObservation } from "../../../stacks/nest/alarm-reader-windows.ts";

it.effect.prop(
  "missing or stale window probes stop suppressing crash sweeps after a bounded wait and fresh probes restore coverage",
  {
    previous: Schema.Boolean,
    source: Schema.Literals(["health", "maintenance", "windows"]),
    step: Schema.Int.check(
      Schema.isBetween({ maximum: 30_000, minimum: 1000 })
    ),
  },
  ({ previous, source, step }) =>
    Effect.gen(function* failingProbes() {
      const started = 1_000_000;
      const facts = { backup: { end: started + 600_000, start: started } };

      let observation: ReaderWindowObservation | null = previous
        ? updateReaderWindows(null, facts, started)
        : null;

      for (
        let elapsed = 0;
        elapsed <= READER_RECOVERY_GRACE_MS + step;
        elapsed += step
      ) {
        const failed = yield* Effect.fail(source).pipe(
          Effect.match({
            onFailure: (name) => ({ failed: [name] }),
            onSuccess: () => facts,
          })
        );

        observation = updateReaderWindows(
          observation,
          failed,
          started + elapsed
        );

        const selected = readerSweepWindows(
          observation,
          started,
          started + elapsed
        );

        if (elapsed < READER_RECOVERY_GRACE_MS) {
          expect(selected.status).toBe(previous ? "fresh" : "waiting");
          expect(selected.facts).toEqual(previous ? facts : null);
        } else {
          expect(selected.status).toBe("stale");
          expect(selected.facts).toEqual({});
        }
      }

      const now = started + READER_RECOVERY_GRACE_MS + step;
      observation = updateReaderWindows(observation, facts, now);
      expect(readerSweepWindows(observation, started, now)).toEqual({
        facts,
        status: "fresh",
      });
    })
);
