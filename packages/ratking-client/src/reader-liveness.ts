import { MailboxClientError } from "@rat-king/mailbox-client";
import { Clock, Effect, Exit, Fiber, Queue, Ref } from "effect";

import { LEASE_TTL_MS } from "./lease-recovery.ts";

const START_INTAKE_MS = 60_000;

const RECONNECT_MS = 30_000;

const RECONNECT_LIMIT = 8;

const WATCHDOG_MS = 2 * LEASE_TTL_MS;

export const intakeTimeout = (reason: string) =>
  new MailboxClientError({ error: "MailboxUnavailable", reason });

const intakeBudget = Effect.gen(function* intakeBudget() {
  const changed = yield* Queue.sliding<null>(1);
  let expiresAt = (yield* Clock.currentTimeMillis) + START_INTAKE_MS;
  let failures = 0;

  const verified = Effect.sync(() => {
    expiresAt = Number.POSITIVE_INFINITY;
    failures = 0;
  }).pipe(Effect.andThen(Queue.offer(changed, null)));

  const failed = Clock.currentTimeMillis.pipe(
    Effect.tap((now) =>
      Effect.sync(() => {
        failures += 1;
        expiresAt = Math.min(
          expiresAt,
          now + (failures >= RECONNECT_LIMIT ? 0 : RECONNECT_MS)
        );
      })
    ),
    Effect.andThen(Queue.offer(changed, null))
  );

  const expired: Effect.Effect<never, MailboxClientError> = Effect.gen(
    function* waitForIntake() {
      const now = yield* Clock.currentTimeMillis;
      const remaining = expiresAt - now;

      if (remaining <= 0) {
        return yield* intakeTimeout(
          failures >= RECONNECT_LIMIT
            ? "Reader reconnect budget exhausted"
            : "Reader intake timed out"
        );
      }

      yield* Queue.take(changed).pipe(Effect.timeoutOption(remaining));

      return yield* expired;
    }
  );

  return { expired, failed, verified };
});

export type IntakeBudget = Effect.Success<typeof intakeBudget>;

export const boundIntake = <A, E, R>(
  run: (budget: IntakeBudget) => Effect.Effect<A, E, R>
) =>
  Effect.scoped(
    Effect.gen(function* runIntake() {
      const budget = yield* intakeBudget;
      const consumer = yield* run(budget).pipe(Effect.forkScoped);

      return yield* Effect.raceFirst(Fiber.join(consumer), budget.expired);
    })
  );

export const readerProgress = Effect.gen(function* readerProgress() {
  const last = yield* Ref.make(yield* Clock.currentTimeMillis);

  const mark = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => Ref.set(last, now))
  );

  const stalled: Effect.Effect<string> = Effect.gen(function* waitForStall() {
    const now = yield* Clock.currentTimeMillis;
    const remaining = (yield* Ref.get(last)) + WATCHDOG_MS - now;

    if (remaining <= 0) {
      return "Reader made no progress for two lease TTLs";
    }

    yield* Effect.sleep(remaining);

    return yield* stalled;
  });

  return { mark, stalled };
});

export const watchReader = <A, E, R>(
  reader: Effect.Effect<A, E, R>,
  progress: Effect.Success<typeof readerProgress>,
  restart: (reason: string) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* superviseWorker() {
      yield* progress.mark;
      const worker = yield* reader.pipe(Effect.forkScoped);

      return yield* Effect.raceFirst(
        Fiber.await(worker).pipe(
          Effect.map((exit) =>
            Exit.isSuccess(exit) ? "Reader stopped" : "Reader fiber failed"
          )
        ),
        progress.stalled
      );
    })
  ).pipe(
    Effect.tap((reason) =>
      Effect.logWarning("Rat King reader restarting", { reason })
    ),
    Effect.flatMap(restart),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever
  );
