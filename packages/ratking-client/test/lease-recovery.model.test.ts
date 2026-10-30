/* oxlint-disable typescript/promise-function-async -- fast-check commands bridge into the existing Effect test context. */
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
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { consume } from "../../mailbox-client/src/consume.ts";
import type { ConsumeOptions } from "../../mailbox-client/src/consume.ts";
import { MailboxClientError } from "../../mailbox-client/src/error.ts";
import { RatKingMailbox } from "../../mailbox-client/src/mailbox.ts";
import type { AcquireRequest } from "../../mailbox-client/src/mailbox.ts";
import { parkUntilClaimOrRetry, recoverHeld } from "../src/lease-recovery.ts";

const did = "did:web:agent.example.invalid";

const LEASE_MS = 300_000;

const GRACE_MS = 45_000;

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

const Steps = Schema.Array(
  Schema.Literals([
    "tick",
    "minute",
    "lapse",
    "renew-ok",
    "renew-fail",
    "release-timeout",
    "foreign-acquire",
    "takeover",
    "lost-reply",
    "claim",
    "restart",
  ])
).check(Schema.isMaxLength(24));

type Step = (typeof Steps.Type)[number];

const stamp = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));

const issue = (
  session: string,
  generation: number,
  issuedAt: number,
  expiresAt: string,
  leaseId: string
) =>
  Schema.decodeUnknownSync(Lease.Main)({
    did,
    expiresAt,
    generation,
    harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: session },
    issuedAt: stamp(issuedAt),
    leaseId,
  });

const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

const leaseIdFor = (n: number) =>
  `3mxcx45mn7s${ALPHABET[Math.floor(n / 32) % 32]}${ALPHABET[n % 32]}`;

const sessionOf = (lease: Lease.MainValue) =>
  Schema.is(Schema.String)(lease.harness.sessionId)
    ? lease.harness.sessionId
    : "unknown";

interface World {
  down: boolean;
  eligibleSince: number | undefined;
  gate: Deferred.Deferred<boolean> | undefined;
  generations: number;
  holder: Lease.MainValue | undefined;
  hangRelease: boolean;
  lostReply: boolean;
  parkedForeign: boolean;
  parkedWrongly: string | undefined;
  reader: Fiber.Fiber<void> | undefined;
  reading: boolean;
  session: string;
  sessions: number;
  state: "acquiring" | "live" | "send-only";
}

const unavailable = new MailboxClientError({
  error: "MailboxUnavailable",
  reason: "celld restarting",
});

const run = (world: World, mailbox: typeof RatKingMailbox.Service) =>
  Effect.gen(function* readerLoop() {
    const { session } = world;
    const lastLease = yield* Ref.make(Option.none<Lease.MainValue>());

    const park = Effect.gen(function* parkOnForeign() {
      const now = yield* Clock.currentTimeMillis;

      const foreign =
        world.holder !== undefined &&
        Date.parse(world.holder.expiresAt) > now &&
        sessionOf(world.holder) !== session;

      if (!foreign) {
        world.parkedWrongly = `parked at ${now - BASE} with holder ${world.holder === undefined ? "none" : `${sessionOf(world.holder)} until ${Date.parse(world.holder.expiresAt) - BASE}`}`;
      }

      world.parkedForeign = foreign;
      world.state = "send-only";
      world.gate = yield* Deferred.make<boolean>();
      yield* parkUntilClaimOrRetry(world.gate);
      world.gate = undefined;
      world.parkedForeign = false;
    });

    return yield* Effect.gen(function* once() {
      world.state = "acquiring";
      const resume = yield* Ref.get(lastLease);

      const options: ConsumeOptions = {
        failOnHeld: true,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: session,
        },
        onLease: (lease) =>
          Ref.set(lastLease, Option.some(lease)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                world.reading = true;
                world.state = "live";
              })
            )
          ),
      };

      if (Option.isSome(resume)) {
        Object.assign(options, {
          resume: {
            did,
            generation: resume.value.generation,
            leaseId: resume.value.leaseId,
          },
        });
      }

      yield* consume(mailbox, did, () => Effect.void, options).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            world.reading = false;
          })
        )
      );
    }).pipe(
      Effect.catchIf(
        (error) => error.error === "LeaseHeld",
        () =>
          recoverHeld({
            park,
            resolve: mailbox.lease.resolve(did).pipe(
              Effect.map((lease) =>
                Option.some({
                  expiresAt: lease.expiresAt,
                  session: sessionOf(lease),
                })
              ),
              Effect.catchIf(
                (failure) => failure.error === "LeaseNotFound",
                () => Effect.succeed(Option.none())
              )
            ),
            retrying: Effect.sync(() => {
              world.state = "acquiring";
            }),
            session,
          })
      ),
      Effect.catch(() => Effect.sleep("8 seconds")),
      Effect.forever
    );
  });

const gatedBy = <A>(
  world: World,
  effect: Effect.Effect<A, MailboxClientError>
) => (world.down ? Effect.fail(unavailable) : effect);

const liveAt = (world: World, time: number) =>
  world.holder !== undefined && Date.parse(world.holder.expiresAt) > time;

const fakeMailbox = (world: World) =>
  Effect.gen(function* fake() {
    return yield* RatKingMailbox.pipe(
      Effect.provide(
        Layer.mock(RatKingMailbox, {
          lease: {
            acquire: (input: AcquireRequest) =>
              Effect.suspend(() =>
                gatedBy(
                  world,
                  Effect.gen(function* acquire() {
                    const time = yield* Clock.currentTimeMillis;

                    if (
                      liveAt(world, time) &&
                      world.holder?.leaseId !== input.leaseId
                    ) {
                      return yield* new MailboxClientError({
                        error: "LeaseHeld",
                        reason: "held",
                      });
                    }

                    world.generations += 1;

                    const session = Schema.is(Schema.String)(
                      input.harness.sessionId
                    )
                      ? input.harness.sessionId
                      : "unknown";

                    world.holder = issue(
                      session,
                      world.generations,
                      time,
                      input.expiresAt,
                      leaseIdFor(world.generations)
                    );

                    if (world.lostReply) {
                      world.lostReply = false;

                      return yield* Effect.never;
                    }

                    return world.holder;
                  })
                )
              ),
            release: () =>
              Effect.suspend(() =>
                world.hangRelease
                  ? Effect.never
                  : gatedBy(
                      world,
                      Effect.sync(() => {
                        world.holder = undefined;
                      })
                    )
              ),
            renew: (input) =>
              Effect.suspend(() =>
                gatedBy(
                  world,
                  Effect.gen(function* renew() {
                    const time = yield* Clock.currentTimeMillis;

                    if (
                      world.holder === undefined ||
                      world.holder.leaseId !== input.leaseId ||
                      !liveAt(world, time)
                    ) {
                      return yield* new MailboxClientError({
                        error: "LeaseMismatch",
                        reason: "fence",
                      });
                    }

                    world.holder = issue(
                      sessionOf(world.holder),
                      world.holder.generation,
                      time,
                      input.expiresAt,
                      world.holder.leaseId
                    );

                    return world.holder;
                  })
                )
              ),
            resolve: () =>
              Effect.suspend(() =>
                gatedBy(
                  world,
                  world.holder === undefined
                    ? Effect.fail(
                        new MailboxClientError({
                          error: "LeaseNotFound",
                          reason: "none",
                        })
                      )
                    : Effect.succeed(world.holder)
                )
              ),
          },
          watch: () => Stream.never,
        })
      )
    );
  });

it.effect.prop(
  "a reader recovers its own lapsed lease and never takes a live foreign one",
  [Arbitrary.schema(Steps)],
  ([steps]) =>
    Effect.gen(function* leaseModel() {
      yield* TestClock.setTime(BASE);

      const world: World = {
        down: false,
        eligibleSince: undefined,
        gate: undefined,
        generations: 0,
        hangRelease: false,
        holder: undefined,
        lostReply: false,
        parkedForeign: false,
        parkedWrongly: undefined,
        reader: undefined,
        reading: false,
        session: "pi-1",
        sessions: 1,
        state: "acquiring",
      };

      const mailbox = yield* fakeMailbox(world);

      const scope = yield* Effect.scope;

      const start = Effect.gen(function* spawn() {
        world.reader = yield* run(world, mailbox).pipe(Effect.forkIn(scope));
      });

      const settle = TestClock.adjust("1 millis");

      const check: Effect.Effect<void> = Effect.gen(function* invariants() {
        const now = yield* Clock.currentTimeMillis;
        const { holder } = world;

        const liveHolder =
          holder !== undefined && Date.parse(holder.expiresAt) > now;

        const own = holder !== undefined && sessionOf(holder) === world.session;

        if (world.reading && liveHolder && !own && holder !== undefined) {
          expect(
            now,
            "reader still reading after a foreign session took the lease"
          ).toBeLessThanOrEqual(
            Date.parse(holder.issuedAt ?? stamp(now)) + 10_000
          );
        }

        if (world.parkedForeign || world.parkedWrongly !== undefined) {
          expect(world.state).toBe("send-only");
        }

        expect(
          world.parkedWrongly,
          "parked although no live foreign session holds the name"
        ).toBeUndefined();

        const eligible = !world.down && !world.reading && (!liveHolder || own);

        if (!eligible) {
          world.eligibleSince = undefined;

          return;
        }

        world.eligibleSince ??= now;

        const free =
          holder !== undefined && (own || !liveHolder)
            ? Date.parse(holder.expiresAt)
            : now;

        const deadline = Math.max(world.eligibleSince, free) + GRACE_MS;

        expect(
          now,
          `reader idle since ${world.eligibleSince - BASE}, own lease free at ${free - BASE}, state ${world.state}`
        ).toBeLessThanOrEqual(deadline);
      });

      const advance = (millis: number) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(millis / 1000) }),
          () => TestClock.adjust(1000).pipe(Effect.andThen(check)),
          { discard: true }
        );

      yield* start;
      yield* settle;

      const context = yield* Effect.context<Scope.Scope>();

      const command = (step: Step): AsyncCommand<object, object> => ({
        check: () => true,
        run: () => {
          const operation = Effect.gen(function* apply() {
            const now = yield* Clock.currentTimeMillis;

            switch (step) {
              case "tick": {
                yield* advance(1000);

                break;
              }

              case "minute": {
                yield* advance(60_000);

                break;
              }

              case "lapse": {
                yield* advance(LEASE_MS + 100_000);

                break;
              }

              case "renew-ok": {
                world.down = false;

                break;
              }

              case "renew-fail": {
                world.down = true;

                break;
              }

              case "release-timeout": {
                world.hangRelease = !world.hangRelease;

                break;
              }

              case "foreign-acquire": {
                if (
                  !world.down &&
                  (world.holder === undefined ||
                    Date.parse(world.holder.expiresAt) <= now)
                ) {
                  world.generations += 1;
                  world.holder = issue(
                    "foreign",
                    world.generations,
                    now,
                    stamp(now + LEASE_MS),
                    leaseIdFor(world.generations)
                  );
                }

                break;
              }

              case "takeover": {
                world.down = true;
                yield* advance(LEASE_MS + 100_000);
                world.down = false;

                const later = yield* Clock.currentTimeMillis;

                if (
                  world.holder === undefined ||
                  Date.parse(world.holder.expiresAt) <= later
                ) {
                  world.generations += 1;
                  world.holder = issue(
                    "foreign",
                    world.generations,
                    later,
                    stamp(later + LEASE_MS),
                    leaseIdFor(world.generations)
                  );
                }

                yield* advance(60_000);

                break;
              }

              case "lost-reply": {
                world.lostReply = true;

                break;
              }

              case "claim": {
                if (world.gate !== undefined) {
                  yield* Deferred.succeed(world.gate, true);
                }

                break;
              }

              case "restart": {
                if (world.reader !== undefined) {
                  yield* Effect.forkIn(Fiber.interrupt(world.reader), scope);
                }

                world.sessions += 1;
                world.session = `pi-${world.sessions}`;
                world.reading = false;
                world.parkedForeign = false;
                world.parkedWrongly = undefined;
                world.gate = undefined;
                world.state = "acquiring";
                yield* start;

                break;
              }

              default: {
                break;
              }
            }

            yield* settle;
            yield* check;
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun requires a Promise per command; this reuses the scoped Effect test services.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => step,
      });

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: {}, real: {} }),
          [...steps, "renew-ok" as const, "lapse" as const].map(command)
        )
      );

      world.hangRelease = false;
      world.down = false;

      if (world.reader !== undefined) {
        yield* Fiber.interrupt(world.reader);
      }
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 40 } }
);
