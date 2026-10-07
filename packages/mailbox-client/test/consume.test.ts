import { it } from "@effect/vitest";
import * as Lease from "@rat-king/lexicon/runtime.lease";
import {
  Arbitrary,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Match,
  Result,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { consume } from "../src/consume.ts";
import { MailboxClientError } from "../src/error.ts";
import { RatKingMailbox } from "../src/index.ts";

const did = "did:web:recipient.invalid";

const lease = (now: number, generation = 1, ttl = 300_000) =>
  Schema.decodeUnknownSync(Lease.Main)({
    did,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + ttl)),
    generation,
    harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "test" },
    issuedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    leaseId: "3mxcx45mn7sex",
  });

const options = { harness: lease(0).harness };

it.effect.prop(
  "consumer renews returned expiry across the cap and releases on cancellation",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 20 }))
    ),
  ],
  ([ttl]) =>
    Effect.gen(function* proof() {
      const acquired = yield* Deferred.make<boolean>();
      const renewed = yield* Deferred.make<boolean>();
      const now = yield* Clock.currentTimeMillis;
      let current = lease(now, 1, ttl);
      let renewals = 0;
      let released = 0;

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            lease: {
              acquire: () =>
                Deferred.succeed(acquired, true).pipe(Effect.as(current)),
              release: () =>
                Effect.sync(() => {
                  released += 1;
                }),
              renew: () =>
                Effect.gen(function* renew() {
                  renewals += 1;
                  const time = yield* Clock.currentTimeMillis;
                  current = lease(time);
                  yield* Deferred.succeed(renewed, true);

                  return current;
                }),
              resolve: () => Effect.succeed(current),
            },
            watch: () => Stream.never,
          })
        )
      );

      const fiber = yield* consume(
        mailbox,
        did,
        () => Effect.void,
        options
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(acquired);
      yield* TestClock.adjust(Math.ceil(ttl / 2));
      yield* Deferred.await(renewed);
      expect(renewals).toBe(1);
      yield* TestClock.adjust(300_001);
      expect(renewals).toBeGreaterThan(1);
      yield* Fiber.interrupt(fiber);
      expect(released).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "renew failure distinguishes expiry from foreign takeover and stops intake",
  [Arbitrary.schema(Schema.Literals(["expired", "foreign", "failure"]))],
  ([kind]) =>
    Effect.gen(function* proof() {
      const acquired = yield* Deferred.make<boolean>();
      const now = yield* Clock.currentTimeMillis;
      const current = lease(now);
      let released = 0;

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            lease: {
              acquire: () =>
                Deferred.succeed(acquired, true).pipe(Effect.as(current)),
              release: () =>
                Effect.sync(() => {
                  released += 1;
                }),
              renew: () =>
                Effect.gen(function* renew() {
                  if (kind === "expired") {
                    yield* TestClock.adjust(300_000);
                  }

                  return yield* new MailboxClientError({
                    error: "LeaseMismatch",
                    reason: "renew refused",
                  });
                }),
              resolve: () =>
                kind === "expired"
                  ? Effect.fail(
                      new MailboxClientError({
                        error: "LeaseNotFound",
                        reason: "expired",
                      })
                    )
                  : Effect.succeed(lease(now, kind === "foreign" ? 2 : 1)),
            },
            watch: () => Stream.never,
          })
        )
      );

      const fiber = yield* consume(
        mailbox,
        did,
        () => Effect.void,
        options
      ).pipe(Effect.result, Effect.forkScoped);

      yield* Deferred.await(acquired);
      yield* TestClock.adjust(150_000);
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure.error).toBe(
          Match.value(kind).pipe(
            Match.when("expired", () => "LeaseExpired"),
            Match.when("foreign", () => "LeaseTakenOver"),
            Match.orElse(() => "LeaseRenewalFailed")
          )
        );
      }

      expect(released).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "LeaseHeld waits for holder expiry instead of failing, then releases",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 10 }))
    ),
  ],
  ([ttl]) =>
    Effect.gen(function* proof() {
      const attempted = yield* Deferred.make<boolean>();
      const acquired = yield* Deferred.make<boolean>();
      const now = yield* Clock.currentTimeMillis;
      const holder = lease(now, 1, ttl);
      let attempts = 0;
      let released = 0;

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            lease: {
              acquire: () =>
                Effect.gen(function* acquire() {
                  attempts += 1;

                  if (attempts === 1) {
                    yield* Deferred.succeed(attempted, true);

                    return yield* new MailboxClientError({
                      error: "LeaseHeld",
                      reason: "held",
                    });
                  }

                  yield* Deferred.succeed(acquired, true);

                  return lease(yield* Clock.currentTimeMillis, 2);
                }),
              release: () =>
                Effect.sync(() => {
                  released += 1;
                }),
              renew: () => Effect.succeed(holder),
              resolve: () => Effect.succeed(holder),
            },
            watch: () => Stream.never,
          })
        )
      );

      const fiber = yield* consume(
        mailbox,
        did,
        () => Effect.void,
        options
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(attempted);
      yield* TestClock.adjust(ttl - 1);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(2);
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(fiber);
      expect(attempts).toBe(2);
      expect(released).toBe(1);
    }).pipe(Effect.scoped)
);
