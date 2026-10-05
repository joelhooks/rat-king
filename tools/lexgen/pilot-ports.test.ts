import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Layer, Schema } from "effect";

import * as PutDidDocument from "../../packages/lexicon/src/admin.putDidDocument.ts";
import {
  clientLayer,
  MailboxClient,
} from "../../packages/lexicon/src/mailbox-client.ts";
import { MailboxHandlers } from "../../packages/lexicon/src/mailbox-handlers.ts";
import {
  MailboxServer,
  serverLayer,
} from "../../packages/lexicon/src/mailbox-server.ts";
import * as Deliver from "../../packages/lexicon/src/mailbox.deliver.ts";
import * as AcquireLease from "../../packages/lexicon/src/runtime.acquireLease.ts";
import * as ReleaseLease from "../../packages/lexicon/src/runtime.releaseLease.ts";
import * as RenewLease from "../../packages/lexicon/src/runtime.renewLease.ts";
import * as ResolveLease from "../../packages/lexicon/src/runtime.resolveLease.ts";
import { TransportFailure } from "../../packages/lexicon/src/transport-failure.ts";
import { Transport } from "../../packages/lexicon/src/transport.ts";
import { XrpcFailure } from "../../packages/lexicon/src/xrpc-failure.ts";

const fixture = Effect.fn("test.pilotFixture")(function* fixture(name: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
    yield* fs.readFileString(
      new URL(`../../lexicons/fixtures/v0/${name}.json`, import.meta.url)
        .pathname
    )
  );
});

const unsupported = () =>
  Effect.fail(
    new XrpcFailure({ error: "UnsupportedTest", response: {}, status: 400 })
  );

it.effect.prop(
  "all pilot HTTP ports round-trip through generated client and routes, including a bodyless release",
  { generation: Arbitrary.schema(ReleaseLease.Input.schema.fields.generation) },
  ({ generation }) =>
    Effect.gen(function* ports() {
      const acquire = yield* Schema.decodeUnknownEffect(AcquireLease.Input)(
        yield* fixture("acquire-lease.input")
      );

      const renew = {
        ...(yield* Schema.decodeUnknownEffect(RenewLease.Input)(
          yield* fixture("renew-lease.input")
        )),
        generation,
      };

      const release = {
        ...(yield* Schema.decodeUnknownEffect(ReleaseLease.Input)(
          yield* fixture("release-lease.input")
        )),
        generation,
      };

      const resolve = yield* Schema.decodeUnknownEffect(ResolveLease.Params)(
        yield* fixture("resolve-lease.params")
      );

      const deliver = {
        ...(yield* Schema.decodeUnknownEffect(Deliver.Input)(
          yield* fixture("deliver.input")
        )),
        generation,
      };

      const registration = yield* Schema.decodeUnknownEffect(
        PutDidDocument.Input
      )(yield* fixture("put-did-document.input"));

      const lease = yield* Schema.decodeUnknownEffect(AcquireLease.Output)(
        yield* fixture("acquire-lease.output")
      );

      const receipt = yield* Schema.decodeUnknownEffect(Deliver.Output)(
        yield* fixture("deliver.output")
      );

      const registered = yield* Schema.decodeUnknownEffect(
        PutDidDocument.Output
      )(yield* fixture("put-did-document.output"));

      const handlers = Layer.succeed(
        MailboxHandlers,
        MailboxHandlers.of({
          ack: unsupported,
          acquireLease: (input) =>
            Effect.sync(() => {
              expect(input).toEqual(acquire);

              return lease;
            }),
          deliver: (input) =>
            Effect.sync(() => {
              expect(input).toEqual(deliver);

              return receipt;
            }),
          list: unsupported,
          putDidDocument: (input) =>
            Effect.sync(() => {
              expect(input).toEqual(registration);

              return registered;
            }),
          releaseLease: (input) =>
            Effect.sync<undefined>(() => {
              expect(input).toEqual(release);
            }),
          renewLease: (input) =>
            Effect.sync(() => {
              expect(input).toEqual(renew);

              return lease;
            }),
          resolveLease: (params) =>
            Effect.sync(() => {
              expect(params).toEqual(resolve);

              return lease;
            }),
          send: unsupported,
        })
      );

      const transport = Layer.effect(
        Transport,
        Effect.gen(function* transport() {
          const server = yield* MailboxServer;

          return Transport.of({
            request: Effect.fn("test.pilotRequest")(function* request(value) {
              const route = server.routes.get(`/xrpc/${value.nsid}`);

              if (route === undefined) {
                return yield* new TransportFailure({
                  cause: null,
                  reason: "Unknown route",
                });
              }

              const response = yield* route.handle(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new TransportFailure({
                      cause,
                      reason: "Schema rejected request",
                    })
                )
              );

              if (value.nsid === ReleaseLease.Method.nsid) {
                expect(response).toEqual({
                  body: "",
                  kind: "text",
                  status: 204,
                });
              }

              return response;
            }),
          });
        })
      ).pipe(Layer.provide(serverLayer.pipe(Layer.provide(handlers))));

      yield* Effect.gen(function* invoke() {
        const client = yield* MailboxClient;
        expect(yield* client.acquireLease(acquire)).toEqual(lease);
        expect(yield* client.renewLease(renew)).toEqual(lease);
        expect(yield* client.releaseLease(release)).toBeUndefined();
        expect(yield* client.resolveLease(resolve)).toEqual(lease);
        expect(yield* client.deliver(deliver)).toEqual(receipt);
        expect(yield* client.putDidDocument(registration)).toEqual(registered);
      }).pipe(Effect.provide(clientLayer.pipe(Layer.provide(transport))));
    }).pipe(Effect.provide(NodeServices.layer))
);
