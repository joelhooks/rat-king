/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Effect.catch is typed failure handling, not a Promise callback. */
import * as AttentionReceipt from "@rat-king/lexicon/attention.receipt";
import * as Defs from "@rat-king/lexicon/defs";
import type * as Lease from "@rat-king/lexicon/runtime.lease";
import type { Scope } from "effect";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Match,
  Option,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { createMachine, initialTransition, transition } from "xstate";

import * as Deadline from "./deadline.ts";
import { MailboxClientError, clientError } from "./error.ts";
import { handoffHistory } from "./handoff-history.ts";
import type {
  AcquireRequest,
  LeaseFence,
  OpenedMessage,
  RatKingMailbox,
} from "./mailbox.ts";
import { retryFailure } from "./retry-metrics.ts";
import type { RetryObserver } from "./retry-metrics.ts";

export const consumerMachine = createMachine({
  context: {},
  id: "mailbox-consumer",
  initial: "acquiring",
  states: {
    acquiring: {
      on: {
        ACQUIRED: { target: "consuming" },
        HELD: { target: "waiting" },
        REFUSED: { target: "closed" },
      },
    },
    closed: { type: "final" },
    consuming: {
      on: {
        LOST: { target: "releasing" },
        RETRYING: { target: "retrying" },
        STOP: { target: "releasing" },
      },
    },
    releasing: { on: { RELEASED: { target: "closed" } } },
    retrying: {
      on: {
        ACQUIRED: { target: "consuming" },
        LOST: { target: "releasing" },
        STOP: { target: "releasing" },
      },
    },
    waiting: { on: { RETRY: { target: "acquiring" } } },
  },
});

export interface MessageMeta {
  readonly ack: Effect.Effect<void, MailboxClientError>;
  readonly redelivered: boolean;
  readonly seq: number;
}

const ATTEMPT_MS = Deadline.LEASE_MS;

const RENEW_FLOOR_MS = 250;

const LEASE_TTL_MS = 300_000;

const attemptTimedOut = (reason: string) =>
  new MailboxClientError({ error: "MailboxUnavailable", reason });

const TIMED_OUT = "Renewal attempt timed out";

const unavailable = (error: MailboxClientError) =>
  error.status === undefined
    ? error.error === "MailboxUnavailable" ||
      error.error === "SocketDisconnected"
    : (error.status >= 500 && error.status < 600) || error.status === 429;

const expiredRefusal = (error: MailboxClientError) =>
  error.error === "InvalidTransition" && error.reason === "Expired message";

const settledRefusal = (error: MailboxClientError) =>
  error.error === "InvalidTransition";

const releasedRefusal = (error: MailboxClientError) =>
  error.error === "LeaseMismatch";

export interface Skipped {
  readonly messageId: string;
  readonly reason: "expired" | "settled" | "unopenable";
  readonly senderDid: string;
  readonly seq: number;
}

export interface ConsumeOptions {
  readonly onDrained?: () => Effect.Effect<void, MailboxClientError>;
  readonly onRetryMetric?: RetryObserver;
  readonly onAttentionReceipt?: (
    receipt: AttentionReceipt.MainValue
  ) => Effect.Effect<void>;
  readonly ackOnReturn?: boolean;
  readonly harness: Lease.MainValue["harness"];
  readonly renders?: readonly string[];
  readonly resume?: LeaseFence;
  readonly afterSeq?: number;
  readonly onLease?: (
    lease: Lease.MainValue,
    progress: boolean,
    source: "acquire" | "intake" | "renew"
  ) => Effect.Effect<void, MailboxClientError, Scope.Scope>;
  readonly onRetry?: (error: MailboxClientError) => Effect.Effect<void>;
  readonly leaseName?: string;
  readonly failOnHeld?: boolean;
  readonly unopenable?: (
    event: Defs.MessageEventValue,
    error: MailboxClientError
  ) => Effect.Effect<Option.Option<OpenedMessage>>;
  readonly onSkip?: (skipped: Skipped) => Effect.Effect<void>;
}

export const consume = <E, R>(
  mailbox: typeof RatKingMailbox.Service,
  did: string,
  handler: (
    message: OpenedMessage,
    meta: MessageMeta
  ) => Effect.Effect<void, E, R>,
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
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(now + LEASE_TTL_MS)
          ),
          harness: options.harness,
        };

        if (options.renders !== undefined) {
          Object.assign(input, { renders: options.renders });
        }

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

        yield* Effect.logInfo(
          `lease acquire-attempt name=${options.leaseName ?? did} generation=${input.generation ?? "new"} expiresAt=${input.expiresAt} reason=acquire requested`
        );

        return yield* mailbox.lease.acquire(input).pipe(
          Deadline.timeoutOrElse({
            duration: ATTEMPT_MS,
            orElse: () =>
              Effect.fail(attemptTimedOut("Acquire attempt timed out")),
          }),
          Effect.tap(() => options.onRetryMetric?.("acquireOk") ?? Effect.void),
          Effect.tapError(
            (error) =>
              options.onRetryMetric?.(retryFailure("acquire", error)) ??
              Effect.void
          ),
          Effect.tapError((error) =>
            Effect.logInfo(
              `lease acquire-failed name=${options.leaseName ?? did} generation=${input.generation ?? "new"} expiresAt=${input.expiresAt} reason=${JSON.stringify(error.error ?? error.reason)}`
            )
          ),
          Effect.catchIf(
            (error) => error.error === "LeaseHeld",
            (error) =>
              Effect.gen(function* waitHolder() {
                if (options.failOnHeld === true) {
                  yield* step("REFUSED");

                  return yield* Effect.fail(error);
                }

                yield* step("HELD");

                const holder = yield* mailbox.lease.resolve(did).pipe(
                  Deadline.timeout(ATTEMPT_MS),
                  Effect.mapError(clientError),
                  Effect.catchIf(
                    (failure) => failure.error === "LeaseNotFound",
                    () => Effect.void
                  )
                );

                const current = yield* Clock.currentTimeMillis;

                if (holder !== undefined) {
                  yield* Effect.interruptible(
                    Effect.sleep(
                      Math.max(1, Date.parse(holder.expiresAt) - current)
                    )
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
            Schedule.modifyDelay(() => Random.nextBetween(0, 2000)),
            Schedule.while(
              ({ input }: { readonly input: MailboxClientError }) =>
                Deadline.canAttempt(ATTEMPT_MS).pipe(
                  Effect.map(
                    (fits) =>
                      fits &&
                      input.error === "LeaseHeld" &&
                      options.failOnHeld !== true
                  )
                )
            ),
            Deadline.retryBudget(ATTEMPT_MS)
          )
        )
      );

      const logLease = (
        event: string,
        lease: Lease.MainValue,
        reason: string
      ) =>
        Effect.logInfo(
          `lease ${event} name=${options.leaseName ?? did} generation=${lease.generation} expiresAt=${lease.expiresAt} reason=${JSON.stringify(reason)}`
        );

      let current: Lease.MainValue = yield* Effect.acquireRelease(
        acquire.pipe(
          Effect.tap((lease) => logLease("acquire", lease, "acquired"))
        ),
        () =>
          Effect.gen(function* release() {
            yield* step("STOP");
            yield* mailbox.lease
              .release({
                did,
                generation: current.generation,
                leaseId: current.leaseId,
              })
              .pipe(
                Deadline.timeoutOrElse({
                  duration: ATTEMPT_MS,
                  orElse: () =>
                    Effect.fail(attemptTimedOut("Release attempt timed out")),
                }),
                Effect.tap(() => logLease("release", current, "scope closed")),
                Effect.catchIf(releasedRefusal, () =>
                  logLease("loss", current, "release fence mismatch")
                ),
                Effect.tapError((error) =>
                  logLease("release-failed", current, error.reason).pipe(
                    Effect.andThen(
                      Effect.logWarning(
                        "Mailbox lease release not confirmed",
                        error
                      )
                    )
                  )
                ),
                Effect.ignore
              );
            yield* step("RELEASED");
          })
      );

      yield* step("ACQUIRED");

      if (options.onLease !== undefined) {
        yield* options.onLease(current, false, "acquire");
      }

      const fence = () => ({
        did,
        generation: current.generation,
        leaseId: current.leaseId,
      });

      const lost = (error: MailboxClientError) =>
        Effect.gen(function* classifyLoss() {
          yield* step("LOST");

          const actual = yield* mailbox.lease
            .resolve(did)
            .pipe(
              Deadline.timeout("2 seconds"),
              Effect.option,
              Effect.map(Option.getOrUndefined)
            );

          const now = yield* Clock.currentTimeMillis;

          let reason = "LeaseRenewalFailed";

          if (
            error.error === "LeaseExpired" ||
            Date.parse(current.expiresAt) <= now
          ) {
            reason = "LeaseExpired";
          }

          if (
            actual !== undefined &&
            (actual.leaseId !== current.leaseId ||
              actual.generation !== current.generation)
          ) {
            reason = "LeaseTakenOver";
          }

          let event = reason === "LeaseExpired" ? "lapse" : "loss";

          if (reason === "LeaseRenewalFailed" && unavailable(error)) {
            event = "retry";
          }

          yield* logLease(event, current, `${reason}: ${error.reason}`);

          return yield* Effect.fail(
            new MailboxClientError({ error: reason, reason: error.reason })
          );
        });

      let intakeFailureSince: number | null = null;
      let intakeVerifiedAt: number | null = null;
      let checkpoint = options.afterSeq ?? 0;

      const retrying = (error: MailboxClientError, intakeFailed = false) =>
        Effect.gen(function* reportRetry() {
          if (!unavailable(error)) {
            return;
          }

          if (intakeFailed && intakeFailureSince === null) {
            intakeFailureSince = yield* Clock.currentTimeMillis;
          }

          yield* step("RETRYING");
          yield* options.onRetry?.(error) ?? Effect.void;
        });

      const recovered = (renewed: boolean) =>
        Effect.gen(function* recoverReader() {
          const progress =
            !renewed ||
            (intakeFailureSince === null && intakeVerifiedAt !== null);

          if (!renewed) {
            intakeFailureSince = null;
            intakeVerifiedAt = yield* Clock.currentTimeMillis;
          }

          if (progress) {
            yield* step("ACQUIRED");
          }

          yield* (
            options.onLease?.(
              current,
              progress,
              renewed ? "renew" : "intake"
            ) ?? Effect.void
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

        const renewal = {
          ...fence(),
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(renewedAt + LEASE_TTL_MS)
          ),
        };

        if (options.renders !== undefined) {
          Object.assign(renewal, { renders: options.renders });
        }

        current = yield* Effect.suspend(() =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((time) => {
              const left = Date.parse(current.expiresAt) - time;

              if (left <= 0) {
                return Effect.fail(
                  new MailboxClientError({
                    error: "LeaseExpired",
                    reason: "Lease expired during renewal retries",
                  })
                );
              }

              return logLease("renew-attempt", current, "renew requested").pipe(
                Effect.andThen(mailbox.lease.renew(renewal)),
                Deadline.timeoutOrElse({
                  duration: Math.min(left, ATTEMPT_MS),
                  orElse: () =>
                    Effect.fail(
                      left > ATTEMPT_MS
                        ? attemptTimedOut(TIMED_OUT)
                        : new MailboxClientError({
                            error: "LeaseExpired",
                            reason: "Renewal exceeded lease expiry",
                          })
                    ),
                })
              );
            })
          )
        ).pipe(
          Effect.tapError(
            (error) =>
              options.onRetryMetric?.(retryFailure("renew", error)) ??
              Effect.void
          ),
          Effect.tapError((error) =>
            logLease("renew-failed", current, error.reason).pipe(
              Effect.andThen(retrying(error))
            )
          ),
          Effect.retry(
            Schedule.spaced("1 second").pipe(
              Schedule.setInputType<MailboxClientError>(),
              Schedule.modifyDelay(({ input }) =>
                input.reason === TIMED_OUT
                  ? Effect.succeed(0)
                  : Clock.currentTimeMillis.pipe(
                      Effect.flatMap((time) =>
                        Random.nextBetween(
                          0,
                          Math.max(
                            0,
                            Math.min(
                              1000,
                              Date.parse(current.expiresAt) -
                                time -
                                RENEW_FLOOR_MS
                            )
                          )
                        ).pipe(Effect.map((delay) => Math.max(1, delay)))
                      )
                    )
              ),
              Schedule.while(
                ({
                  input,
                  duration,
                }: Schedule.Metadata<unknown, MailboxClientError>) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((time) =>
                      Deadline.canAttempt(
                        RENEW_FLOOR_MS,
                        Duration.toMillis(duration)
                      ).pipe(
                        Effect.map(
                          (fits) =>
                            fits &&
                            unavailable(input) &&
                            Date.parse(current.expiresAt) - time >=
                              RENEW_FLOOR_MS + Duration.toMillis(duration)
                        )
                      )
                    )
                  )
              )
            )
          )
        );
        yield* logLease("renew", current, "renewed");

        yield* recovered(true);

        return yield* Effect.void;
      }).pipe(Effect.repeat(Schedule.spaced("0 millis")), Effect.catch(lost));

      const handed = handoffHistory();

      const intake = Stream.suspend(() =>
        mailbox.watch(checkpoint, fence(), (error) => retrying(error, true))
      ).pipe(
        Stream.tap(() => recovered(false)),
        Stream.tapError((error) => retrying(error, true)),
        Stream.retry(
          Schedule.spaced("1 second").pipe(
            Schedule.while(
              ({ input }: { readonly input: MailboxClientError }) =>
                Clock.currentTimeMillis.pipe(
                  Effect.map(
                    (now) =>
                      unavailable(input) &&
                      intakeFailureSince !== null &&
                      now - intakeFailureSince + 1000 < LEASE_TTL_MS
                  )
                )
            )
          )
        ),
        Stream.runForEach((batch) =>
          Effect.forEach(
            batch.events,
            (event) =>
              Effect.gen(function* accept() {
                if (
                  Schema.is(AttentionReceipt.Main)(event) &&
                  options.onAttentionReceipt !== undefined
                ) {
                  yield* options.onAttentionReceipt(event);
                }

                if (!Schema.is(Defs.MessageEvent)(event)) {
                  return;
                }

                const key = JSON.stringify([
                  event.receipt.message.senderDid,
                  event.receipt.message.messageId,
                ]);

                if (options.ackOnReturn === false && handed.has(key)) {
                  return;
                }

                const { onSkip, unopenable } = options;

                const skip = (reason: Skipped["reason"]) =>
                  onSkip === undefined
                    ? Effect.void
                    : onSkip({
                        messageId: event.receipt.message.messageId,
                        reason,
                        senderDid: event.receipt.message.senderDid,
                        seq: event.seq,
                      });

                const opened = yield* mailbox
                  .open(event.envelope, event.receipt)
                  .pipe(
                    Effect.map(Option.some),
                    Effect.catch((error) =>
                      unopenable === undefined
                        ? Effect.fail(error)
                        : unopenable(event, error)
                    )
                  );

                if (Option.isNone(opened)) {
                  yield* skip("unopenable");

                  return;
                }

                const message = opened.value;
                const input = { ...fence(), message: event.receipt.message };

                const delivered = yield* mailbox.deliver(input).pipe(
                  Effect.map(({ receipt }) =>
                    Match.value(receipt.state).pipe(
                      Match.when("expired", () =>
                        Option.some("expired" as const)
                      ),
                      Match.when("acked", () =>
                        Option.some("settled" as const)
                      ),
                      Match.orElse(() => Option.none())
                    )
                  ),
                  Effect.catchIf(expiredRefusal, () =>
                    Effect.succeed(Option.some("expired" as const))
                  ),
                  Effect.catchIf(settledRefusal, () =>
                    Effect.succeed(Option.some("settled" as const))
                  )
                );

                if (Option.isSome(delivered)) {
                  yield* skip(delivered.value);

                  return;
                }

                const ack =
                  event.receipt.delegatedTo === undefined
                    ? mailbox.ack(input).pipe(
                        Effect.catchIf(settledRefusal, () => Effect.void),
                        Effect.asVoid
                      )
                    : Effect.void;

                handed.add(key);
                yield* handler(message, {
                  ack,
                  redelivered: event.receipt.state === "delivered",
                  seq: event.seq,
                }).pipe(
                  Effect.onError(() => Effect.sync(() => handed.delete(key)))
                );

                if (options.ackOnReturn !== false) {
                  yield* ack;
                }
              }),
            { discard: true }
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                checkpoint = batch.throughSeq;
              })
            ),
            Effect.andThen(() =>
              batch.hasMore !== true && options.onDrained !== undefined
                ? options.onDrained()
                : Effect.void
            )
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
