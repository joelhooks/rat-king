import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientError } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { ownIdentity, prepare } from "../src/prepare.ts";
import { WebSocketPort } from "../src/watch.ts";
import { identity } from "./identity.ts";

it.effect.prop(
  "socket reconnect failures are observable and exhaust their retry budget without a wall-clock wait",
  { after: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 })) },
  ({ after }) =>
    Effect.gen(function* reconnects() {
      const own = yield* identity("did:web:reader.invalid");

      const client = yield* prepare({
        endpoint: "https://mailbox.invalid",
        own: yield* ownIdentity(own),
        peers: [],
        serviceDid: "did:web:service.invalid",
      }).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected poll"))
          )
        )
      );

      const firstRetry = yield* Deferred.make<boolean>();
      let retries = 0;

      const fiber = yield* client.mailbox
        .watch(
          after,
          { did: own.did, generation: 1, leaseId: "3mxcx45mn7sex" },
          () =>
            Effect.sync(() => {
              retries += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(firstRetry, true)),
              Effect.asVoid
            )
        )
        .pipe(
          Stream.runDrain,
          Effect.provideService(WebSocketPort, {
            connect: () => {
              throw new Error("connection refused");
            },
          }),
          Effect.forkScoped
        );

      yield* Deferred.await(firstRetry);
      const began = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(300_000);
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(failure.error).toBe("SocketDisconnected");
      expect(retries).toBeGreaterThan(1);
      expect((yield* Clock.currentTimeMillis) - began).toBe(300_000);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 3 } }
);

it.effect.prop(
  "the real transport classifies connection failures as unavailable without treating encoding failures as transient",
  { network: Schema.Boolean },
  ({ network }) =>
    Effect.gen(function* transportErrors() {
      const own = yield* identity("did:web:reader.invalid");

      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: network
              ? new HttpClientError.TransportError({ request })
              : new HttpClientError.EncodeError({ request }),
          })
        )
      );

      const client = yield* prepare({
        endpoint: "https://mailbox.invalid",
        own: yield* ownIdentity(own),
        peers: [],
        serviceDid: "did:web:service.invalid",
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));

      const failure = yield* client.mailbox.lease
        .resolve(own.did)
        .pipe(Effect.flip);

      expect(failure.error === "MailboxUnavailable").toBe(network);
      expect(failure.status).toBeUndefined();
    }),
  { arbitrary: { runs: 4 } }
);
