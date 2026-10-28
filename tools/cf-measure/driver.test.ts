import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { MailboxClientError } from "../../packages/mailbox-client/src/error.ts";
import { drive } from "./driver.ts";
import type { DriverPort } from "./driver.ts";
import type { Event } from "./model.ts";

it.effect.prop(
  "fake readers stop and release at the deadline; burst pacing and all message phases remain observable",
  {
    burst: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 })),
  },
  ({ burst }) =>
    Effect.gen(function* fakeDriver() {
      const events: Event[] = [];
      const handlers = new Map<number, Parameters<DriverPort["read"]>[2]>();
      const first = yield* Deferred.make<boolean>();
      let released = 0;

      const port: DriverPort = {
        read: (index, ready, receive) =>
          Effect.gen(function* reader() {
            handlers.set(index, receive);
            yield* ready;

            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released += 1;
              })
            )
          ),
        send: (_from, to, body) =>
          Effect.gen(function* sender() {
            const handler = handlers.get(to);

            if (handler === undefined) {
              throw new Error("Sender ran before lease readiness");
            }

            yield* handler(body, Effect.void);
          }).pipe(
            Effect.mapError(
              () =>
                new MailboxClientError({ error: "FakeReceive", reason: "fake" })
            )
          ),
      };

      const emit = (event: Event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.asVoid,
          Effect.andThen(
            event.kind === "accepted"
              ? Deferred.succeed(first, true).pipe(Effect.asVoid)
              : Effect.void
          )
        );

      const fiber = yield* drive(
        {
          burst,
          drainSeconds: 1.5,
          perDay: 86_400 * burst,
          readers: 2,
          seconds: 10,
        },
        port,
        emit
      ).pipe(Effect.provide(NodeCrypto.layer), Effect.forkScoped);

      yield* Deferred.await(first);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);

      expect(released).toBe(2);
      expect(events.filter((event) => event.kind === "accepted").length).toBe(
        9 * burst
      );
      expect(events.filter((event) => event.kind === "received")).toHaveLength(
        events.filter((event) => event.kind === "accepted").length
      );
      expect(events.at(-1)).toMatchObject({ incomplete: 0, kind: "summary" });
    })
);

it.effect.prop(
  "idle runs hold readers without sends; missing leases fail at the deadline instead of reporting an empty success",
  { acquire: Schema.Boolean },
  ({ acquire }) =>
    Effect.gen(function* idleDeadline() {
      const started = yield* Deferred.make<boolean>();
      let sends = 0;
      let released = 0;

      const port: DriverPort = {
        read: (_index, ready) =>
          Effect.gen(function* idleReader() {
            yield* Deferred.succeed(started, true);

            if (acquire) {
              yield* ready;
            }

            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released += 1;
              })
            )
          ),
        send: () =>
          Effect.sync(() => {
            sends += 1;
          }),
      };

      const fiber = yield* drive(
        { burst: 1, drainSeconds: 1, perDay: 0, readers: 2, seconds: 2 },
        port,
        () => Effect.void
      ).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.result,
        Effect.forkScoped
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);

      expect(Result.isSuccess(result)).toBe(acquire);
      expect(sends).toBe(0);
      expect(released).toBe(2);
    })
);

it.effect(
  "reader failure interrupts senders and writes a classified final summary",
  () =>
    Effect.gen(function* readerFailure() {
      const events: Event[] = [];

      const port: DriverPort = {
        read: () =>
          Effect.fail(
            new MailboxClientError({ error: "LeaseTakenOver", reason: "fake" })
          ),
        send: () => Effect.void,
      };

      const result = yield* drive(
        { burst: 1, drainSeconds: 1, perDay: 12_000, readers: 2, seconds: 10 },
        port,
        (event) =>
          Effect.sync(() => {
            events.push(event);
          })
      ).pipe(Effect.provide(NodeCrypto.layer), Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(events.at(-1)).toMatchObject({
        errors: { LeaseTakenOver: 1 },
        kind: "summary",
      });
    })
);
