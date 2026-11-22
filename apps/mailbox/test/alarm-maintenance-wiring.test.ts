import { it } from "@effect/vitest";
import { Console, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { runAlarmMaintenanceCycle } from "../../../stacks/nest/alarm-command.ts";
import { FleetError } from "../../../stacks/nest/stage-config.ts";

it.effect(
  "the alarm finishes inbox ingestion first, then runs its cycle and notices concurrently with sanitized deadlines",
  () =>
    Effect.gen(function* wiring() {
      const cycleStarted = yield* Deferred.make<null>();
      const noticeStarted = yield* Deferred.make<null>();
      const console = yield* Console.Console;
      const logs: string[] = [];
      const diagnostics: string[] = [];
      const overrides = {};
      let attempted = false;

      const ingest = Effect.gen(function* delayedRead() {
        yield* Effect.sleep("1 second");
        attempted = true;

        return yield* new FleetError({
          reason:
            "could not read /fixture/private-request containing a private reason",
        });
      });

      const cycle = Effect.gen(function* sample() {
        expect(attempted).toBe(true);
        yield* Deferred.succeed(cycleStarted, null);
        yield* Deferred.await(noticeStarted);

        return "sampled";
      });

      const notices = Effect.gen(function* send() {
        yield* Deferred.await(cycleStarted);
        yield* Deferred.succeed(noticeStarted, null);

        return yield* Effect.never;
      });

      const completed = runAlarmMaintenanceCycle(
        cycle,
        ingest,
        notices,
        ({ reason }) => {
          diagnostics.push(reason);
        }
      ).pipe(
        Effect.provideService(
          Console.Console,
          Object.assign(overrides, console, {
            error: (...args: readonly unknown[]) => {
              logs.push(args.join(" "));
            },
          })
        )
      );

      const fiber = yield* Effect.forkChild(completed);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(noticeStarted);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBe("sampled");
      expect(diagnostics).toEqual([
        "Alarm step maintenance.inbox failed (FleetError)",
        "Alarm step maintenance.notices failed (TimeoutError)",
      ]);
      expect(logs).toEqual(
        diagnostics.map((line) => `${line}; input values withheld`)
      );
    })
);
