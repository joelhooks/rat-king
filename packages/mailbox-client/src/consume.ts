/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Effect.catch is typed failure handling, not a Promise callback. */
import * as Defs from "@rat-king/lexicon/defs";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import { Clock, DateTime, Effect, Schedule, Schema, Stream } from "effect";
import { createMachine, initialTransition, transition } from "xstate";

import { MailboxClientError } from "./error.ts";
import type {
  AcquireRequest,
  LeaseFence,
  OpenedMessage,
  RatKingMailbox,
} from "./mailbox.ts";

export const consumerMachine = createMachine({
  context: {},
  id: "mailbox-consumer",
  initial: "acquiring",
  states: {
    acquiring: {
      on: { ACQUIRED: { target: "consuming" }, HELD: { target: "waiting" } },
    },
    closed: { type: "final" },
    consuming: {
      on: { LOST: { target: "releasing" }, STOP: { target: "releasing" } },
    },
    releasing: { on: { RELEASED: { target: "closed" } } },
    waiting: { on: { RETRY: { target: "acquiring" } } },
  },
});

export interface ConsumeOptions {
  readonly harness: Lease.MainValue["harness"];
  readonly resume?: LeaseFence;
  readonly afterSeq?: number;
  readonly onLease?: (lease: Lease.MainValue) => Effect.Effect<void>;
}

export const consume = <E, R>(
  mailbox: typeof RatKingMailbox.Service,
  did: string,
  handler: (message: OpenedMessage) => Effect.Effect<void, E, R>,
  options: ConsumeOptions
): Effect.Effect<void, E | MailboxClientError, R> =>
  Effect.scoped(
    Effect.gen(function* runConsumer() {
      let [state] = initialTransition(consumerMachine);

      const step = (event: string) =>
        Effect.sync(() => {
          [state] = transition(consumerMachine, state, { type: event });
        });

      const acquire = Effect.gen(function* acquire() {
        const now = yield* Clock.currentTimeMillis;

        const input: AcquireRequest = {
          did,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
          harness: options.harness,
        };

        if (options.resume !== undefined) {
          if (options.resume.did !== did) {
            return yield* new MailboxClientError({
              reason: "Resume fence identity mismatch",
            });
          }

          Object.assign(input, {
            generation: options.resume.generation,
            leaseId: options.resume.leaseId,
          });
        }

        return yield* mailbox.lease.acquire(input).pipe(
          Effect.catchIf(
            (error) => error.error === "LeaseHeld",
            (error) =>
              Effect.gen(function* waitHolder() {
                yield* step("HELD");

                const holder = yield* mailbox.lease.resolve(did).pipe(
                  Effect.catchIf(
                    (failure) => failure.error === "LeaseNotFound",
                    () => Effect.void
                  )
                );

                const current = yield* Clock.currentTimeMillis;

                if (holder !== undefined) {
                  yield* Effect.sleep(
                    Math.max(1, Date.parse(holder.expiresAt) - current)
                  );
                }

                yield* step("RETRY");

                return yield* Effect.fail(error);
              })
          )
        );
      }).pipe(
        Effect.retry(
          Schedule.spaced("1 millis").pipe(
            Schedule.while(
              ({ input }: { readonly input: MailboxClientError }) =>
                input.error === "LeaseHeld"
            )
          )
        )
      );

      let current: Lease.MainValue = yield* Effect.acquireRelease(acquire, () =>
        Effect.gen(function* release() {
          yield* step("STOP");
          yield* mailbox.lease
            .release({
              did,
              generation: current.generation,
              leaseId: current.leaseId,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Mailbox lease release not confirmed",
                  error.error
                )
              ),
              Effect.ignore
            );
          yield* step("RELEASED");
        })
      );

      yield* step("ACQUIRED");

      if (options.onLease !== undefined) {
        yield* options.onLease(current);
      }

      const fence = () => ({
        did,
        generation: current.generation,
        leaseId: current.leaseId,
      });

      const lost = (error: MailboxClientError) =>
        Effect.gen(function* classifyLoss() {
          yield* step("LOST");

          const actual = yield* mailbox.lease.resolve(did).pipe(
            Effect.catchIf(
              (failure) => failure.error === "LeaseNotFound",
              () => Effect.void
            )
          );

          const now = yield* Clock.currentTimeMillis;

          let reason = "LeaseRenewalFailed";

          if (Date.parse(current.expiresAt) <= now) {
            reason = "LeaseExpired";
          }

          if (
            actual !== undefined &&
            (actual.leaseId !== current.leaseId ||
              actual.generation !== current.generation)
          ) {
            reason = "LeaseTakenOver";
          }

          return yield* Effect.fail(
            new MailboxClientError({ error: reason, reason: error.reason })
          );
        });

      const renew = Effect.gen(function* renew() {
        const now = yield* Clock.currentTimeMillis;
        const remaining = Date.parse(current.expiresAt) - now;

        if (remaining <= 0) {
          return yield* new MailboxClientError({
            error: "LeaseExpired",
            reason: "Lease expired before renewal",
          });
        }

        yield* Effect.sleep(Math.max(1, Math.floor(remaining / 2)));
        const renewedAt = yield* Clock.currentTimeMillis;
        current = yield* mailbox.lease.renew({
          ...fence(),
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(renewedAt + 300_000)
          ),
        });

        if (options.onLease !== undefined) {
          yield* options.onLease(current);
        }

        return yield* Effect.void;
      }).pipe(Effect.repeat(Schedule.spaced("0 millis")), Effect.catch(lost));

      const intake = mailbox.watch(options.afterSeq ?? 0, fence()).pipe(
        Stream.runForEach((batch) =>
          Effect.forEach(
            batch.events,
            (event) =>
              Effect.gen(function* accept() {
                if (!Schema.is(Defs.MessageEvent)(event)) {
                  return;
                }

                const message = yield* mailbox.open(event.envelope);
                const input = { ...fence(), message: event.receipt.message };
                yield* mailbox.deliver(input);
                yield* handler(message);
                yield* mailbox.ack(input);
              }),
            { discard: true }
          )
        ),
        Effect.catch((error): Effect.Effect<never, E | MailboxClientError> => {
          if (
            Schema.is(MailboxClientError)(error) &&
            error.error === "LeaseMismatch"
          ) {
            return lost(error);
          }

          return Effect.fail(error);
        })
      );

      yield* Effect.raceFirst(intake, renew);
    })
  );
