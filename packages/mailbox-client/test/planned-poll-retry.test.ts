import { it } from "@effect/vitest";
import * as Lease from "@rat-king/lexicon/runtime.lease";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { consume } from "../src/consume.ts";
import { MailboxClientError } from "../src/error.ts";
import { RatKingMailbox } from "../src/mailbox.ts";

it.effect.prop(
  "a transient poll outage retries with the same fence instead of releasing the reader, and successful intake returns it live",
  {
    duration: Schema.Int.check(
      Schema.isBetween({ maximum: 150_000, minimum: 20_000 })
    ),
  },
  ({ duration }) =>
    Effect.gen(function* pollOutage() {
      const began = yield* Clock.currentTimeMillis;
      const acquired = yield* Deferred.make<boolean>();
      const resumed = yield* Deferred.make<boolean>();
      const did = "did:web:reader.example.invalid";
      const states: string[] = [];
      let acquisitions = 0;
      let releases = 0;
      let subscriptions = 0;

      const issue = (now: number) =>
        Schema.decodeUnknownSync(Lease.Main)({
          did,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
          generation: 1,
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId: "fixture",
          },
          leaseId: "3mxcx45mn7sex",
        });

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            lease: {
              acquire: () =>
                Effect.sync(() => {
                  acquisitions += 1;
                }).pipe(
                  Effect.andThen(Deferred.succeed(acquired, true)),
                  Effect.as(issue(began))
                ),
              release: () =>
                Effect.sync(() => {
                  releases += 1;
                }),
              renew: () => Clock.currentTimeMillis.pipe(Effect.map(issue)),
              resolve: () => Effect.succeed(issue(began)),
            },
            watch: (_, fence) =>
              Stream.unwrap(
                Effect.gen(function* subscription() {
                  subscriptions += 1;
                  expect(fence.generation).toBe(1);
                  expect(fence.leaseId).toBe("3mxcx45mn7sex");

                  const now = yield* Clock.currentTimeMillis;

                  if (now < began + duration) {
                    return Stream.fail(
                      new MailboxClientError({
                        error: "MailboxUnavailable",
                        reason: "planned stop",
                        status: 503,
                      })
                    );
                  }

                  return Stream.make({ events: [], throughSeq: 0 }).pipe(
                    Stream.tap(() => Deferred.succeed(resumed, true)),
                    Stream.concat(Stream.never)
                  );
                })
              ),
          })
        )
      );

      const fiber = yield* consume(mailbox, did, () => Effect.void, {
        harness: issue(began).harness,
        onLease: () =>
          Effect.sync(() => {
            states.push("Live");
          }),
        onRetry: () =>
          Effect.sync(() => {
            states.push("Retrying");
          }),
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(acquired);
      yield* TestClock.adjust(duration + 1000);
      yield* Deferred.await(resumed);
      expect(states).toContain("Retrying");
      expect(states.at(-1)).toBe("Live");
      expect(acquisitions).toBe(1);
      expect(subscriptions).toBeGreaterThan(1);
      expect(releases).toBe(0);
      yield* Fiber.interrupt(fiber);
      expect(releases).toBe(1);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 8 } }
);
