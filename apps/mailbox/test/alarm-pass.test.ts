import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  alarmCycleReporter,
  runAlarmPass,
  runAlarmWork,
} from "../../../stacks/nest/alarm-pass.ts";

it.effect.prop(
  "a hung pass requests fatal exit at five minutes, without waiting for the cycle or its cleanup",
  [Schema.Boolean],
  ([stuckCleanup]) =>
    Effect.gen(function* proof() {
      const expired = yield* Deferred.make<{ ms: number; pending: string }>();
      const release = yield* Deferred.make<null>();

      const hung = stuckCleanup
        ? Effect.never.pipe(Effect.ensuring(Deferred.await(release)))
        : Effect.uninterruptible(Deferred.await(release));

      const pings: string[] = [];

      const pass = yield* runAlarmPass(
        (track) =>
          Effect.sync(() => {
            track("fixture-read");
          }).pipe(
            Effect.andThen(runAlarmWork(hung, () => Effect.void)),
            Effect.as(true)
          ),
        {
          notify: (socket) =>
            Effect.sync(() => {
              pings.push(socket);
            }),
          notifySocket: "/fixture/notify",
          onDeadline: (evidence) =>
            Deferred.succeed(expired, evidence).pipe(
              Effect.andThen(Effect.fail("fatal"))
            ),
        }
      ).pipe(Effect.forkChild);

      yield* Effect.gen(function* checkDeadline() {
        yield* TestClock.adjust(299_999);
        expect(yield* Deferred.isDone(expired)).toBe(false);
        yield* TestClock.adjust(1);
        expect(yield* Deferred.isDone(expired)).toBe(true);
        expect(yield* Deferred.await(expired)).toEqual({
          ms: 300_000,
          pending: "fixture-read",
        });
        expect(pings).toEqual([]);
      }).pipe(Effect.ensuring(Deferred.succeed(release, null)));
      expect(yield* Fiber.join(pass).pipe(Effect.flip)).toBe("fatal");
    })
);

it.effect.prop(
  "a 70-second cycle fails at 55 seconds without exiting, then the next pass runs",
  [Schema.Boolean],
  ([withWatchdog]) =>
    Effect.gen(function* proof() {
      const events: string[] = [];

      const record = (event: string) =>
        Effect.sync(() => {
          events.push(event);
        });

      const options = {
        notify: () => record("ping"),
        notifySocket: withWatchdog ? "/fixture/notify" : undefined,
        onDeadline: () => Effect.fail("unexpected fatal deadline"),
      };

      const passes = yield* Effect.gen(function* runTwoPasses() {
        yield* runAlarmPass(
          () =>
            runAlarmWork(Effect.sleep("70 seconds"), ({ reason }) =>
              record(reason)
            ).pipe(Effect.as(true)),
          options
        );
        yield* runAlarmPass(
          () => record("next pass").pipe(Effect.as(true)),
          options
        );
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust(54_999);
      expect(events).toEqual([]);
      yield* TestClock.adjust(1);
      expect(events).toEqual([
        "Alarm step cycle failed (TimeoutError)",
        ...(withWatchdog ? ["ping", "next pass", "ping"] : ["next pass"]),
      ]);
      yield* Fiber.join(passes);
    })
);

it.effect.prop(
  "only completed passes ping, exactly once and only with a notify socket",
  [Schema.Array(Schema.Literals(["complete", "no-socket", "stop", "failed"]))],
  ([passes]) =>
    Effect.gen(function* proof() {
      for (const pass of passes) {
        const calls: string[] = [];

        const cycle = Effect.sync(() => {
          calls.push("cycle");
        }).pipe(
          Effect.andThen(
            pass === "failed"
              ? Effect.fail("failed")
              : Effect.succeed(pass !== "stop")
          )
        );

        yield* runAlarmPass(() => cycle, {
          notify: (socket) =>
            Effect.sync(() => {
              calls.push(socket);
            }),
          notifySocket: pass === "no-socket" ? undefined : "/fixture/notify",
        }).pipe(Effect.ignore);

        expect(calls).toEqual(
          pass === "complete" ? ["cycle", "/fixture/notify"] : ["cycle"]
        );
      }
    })
);

it.effect.prop(
  "completion logs include cycle duration and never burst within a minute",
  [Schema.Int.check(Schema.isBetween({ maximum: 59_999, minimum: 0 }))],
  ([gap]) =>
    Effect.gen(function* proof() {
      const lines: string[] = [];

      const report = alarmCycleReporter((line) =>
        Effect.sync(() => {
          lines.push(line);
        })
      );

      const started = yield* Clock.monotonicTimeNanos;

      yield* TestClock.adjust(87);
      yield* report(started);
      yield* TestClock.adjust(gap);
      yield* report(started);
      yield* TestClock.adjust(60_000 - gap);
      yield* report(started);

      expect(lines).toEqual([
        '{"alarm":"cycle","ms":87}',
        '{"alarm":"cycle","ms":60087}',
      ]);
    })
);
