import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import type {
  RelaySettingValue,
  ThreadRoutingValue,
} from "@rat-king/ratking-client/config";
import { Directory } from "@rat-king/ratking-client/directory";
import type { Inbound, InboundRecord } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { constVoid } from "effect/Function";
import { HttpClient, HttpClientResponse } from "effect/http";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { fakeMailbox } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

export const didOf = (name: string) => `did:web:${name}.agents.example.invalid`;

export interface FixtureMessage {
  readonly from: string;
  readonly body: string | ((id: string) => string);
  readonly encrypted: boolean;
}

const sockets = (seq: number) =>
  Layer.succeed(WebSocketPort, {
    connect: () => {
      const target = new EventTarget();

      return {
        addEventListener: (type, listener, options) => {
          target.addEventListener(type, listener, options);
        },
        close: constVoid,
        readyState: 1,
        removeEventListener: (type, listener) => {
          target.removeEventListener(type, listener);
        },
        send: () => {
          queueMicrotask(() => {
            target.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify({ seq }) })
            );
          });
        },
      };
    },
  });

export const receiverFixture = Effect.fn("Test.receiverFixture")(
  function* runReceiverFixture(
    messages: readonly FixtureMessage[],
    settings: {
      readonly threadRouting?: readonly ThreadRoutingValue[];
      readonly relays?: readonly RelaySettingValue[];
    },
    rejected = ""
  ) {
    const scope = yield* Effect.scope;
    const fs = yield* FileSystem.FileSystem;
    const state = yield* fs.makeTempDirectoryScoped();
    const mailbox = fakeMailbox("accept");
    const names = ["tester", "gateway", "sender", "operator", "alpha", "beta"];

    const identities = yield* Effect.forEach(
      names,
      (name) => identity(didOf(name)),
      { concurrency: 1 }
    );

    const documents = yield* Effect.forEach(identities, document, {
      concurrency: 1,
    });

    const peer = (name: string) => {
      const value = identities.find((entry) => entry.did === didOf(name));

      if (value === undefined) {
        throw new Error(`Missing fixture identity ${name}`);
      }

      return value;
    };

    const prepareAs = (name: string) =>
      Effect.gen(function* preparePeer() {
        return yield* prepare({
          endpoint: "https://mailbox.example.invalid",
          own: yield* ownIdentity(peer(name)),
          peers: documents,
          serviceDid: "did:web:mailbox.example.invalid",
        });
      });

    const envelopes = yield* Effect.forEach(
      messages,
      (message) =>
        Effect.gen(function* sealInput() {
          const client = yield* prepareAs(message.from);

          return yield* client.seal(didOf("tester"), message.body, {
            encrypt: message.encrypted,
          });
        }).pipe(
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, mailbox.http)
        ),
      { concurrency: 1 }
    );

    const finalId = envelopes.at(-1)?.aad.messageId;
    const completed = yield* Deferred.make<boolean>();
    const received: (Inbound | InboundRecord)[] = [];

    const outgoing: {
      readonly name: string;
      readonly body: string;
      readonly encrypted: boolean;
    }[] = [];

    let acquired = false;

    const http = HttpClient.make((request) =>
      Effect.gen(function* fixtureMailbox() {
        const url = new URL(request.url);
        const nsid = url.pathname.replace("/xrpc/", "");

        if (nsid.endsWith(".list")) {
          const after = Number(url.searchParams.get("afterSeq") ?? 0);

          const events = acquired
            ? envelopes.flatMap((envelope, index) =>
                index + 1 > after
                  ? [
                      {
                        $type: "sh.mschf.ratking.defs#messageEvent",
                        envelope,
                        receipt: {
                          message: {
                            messageId: envelope.aad.messageId,
                            senderDid: envelope.aad.senderDid,
                          },
                          recipientDid: didOf("tester"),
                          seq: index + 1,
                          state: "accepted",
                        },
                        seq: index + 1,
                      },
                    ]
                  : []
              )
            : [];

          const output = yield* Schema.decodeUnknownEffect(
            Schema.toType(List.Output)
          )({ events, throughSeq: acquired ? envelopes.length : 0 });

          return HttpClientResponse.fromWeb(
            request,
            new Response(
              yield* Schema.encodeEffect(Schema.fromJsonString(List.Output))(
                output
              ),
              { headers: { "content-type": "application/json" } }
            )
          );
        }

        if (nsid.endsWith(".acquireLease")) {
          acquired = true;
        }

        if (nsid.endsWith(".releaseLease")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 204 })
          );
        }

        if (
          (nsid.endsWith(".ack") || nsid.endsWith(".deliver")) &&
          Predicate.isTagged(request.body, "Uint8Array")
        ) {
          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ message: Defs.MessageRef }))
          )(new TextDecoder().decode(request.body.body));

          if (nsid.endsWith(".ack") && input.message.messageId === finalId) {
            yield* Deferred.succeed(completed, true);
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              receipt: {
                message: input.message,
                recipientDid: didOf("tester"),
                seq:
                  envelopes.findIndex(
                    (entry) => entry.aad.messageId === input.message.messageId
                  ) + 1,
                state: nsid.endsWith(".ack") ? "acked" : "delivered",
              },
            })
          );
        }

        const response = yield* mailbox.http.execute(request);

        if (nsid.endsWith(".send")) {
          const envelope = mailbox.requests.at(-1);

          if (envelope !== undefined) {
            const name =
              names.find(
                (entry) => didOf(entry) === envelope.aad.recipientDid
              ) ?? "missing";

            const opened = yield* Effect.gen(function* openOutgoing() {
              const client = yield* prepareAs(name);

              return yield* client.open(envelope);
            }).pipe(
              Effect.scoped,
              Effect.provideService(HttpClient.HttpClient, mailbox.http)
            );

            outgoing.push({
              body: opened.body,
              encrypted: opened.encrypted ?? true,
              name,
            });

            if (name === rejected) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  { error: "Forbidden", message: "fixture owner refused" },
                  { status: 403 }
                )
              );
            }
          }
        }

        return response;
      }).pipe(Effect.orDie)
    );

    yield* Effect.gen(function* runReceiver() {
      const directory = yield* Directory;
      const secrets = yield* SecretStore;
      const ratking = yield* RatKing;

      yield* secrets.add(
        "rat_king_fleet_agent_tester_identity",
        Redacted.make(JSON.stringify(peer("tester")))
      );

      for (const [index, name] of names.entries()) {
        const value = documents[index];

        if (value !== undefined) {
          yield* directory.record(name, value);
        }
      }

      yield* ratking.run(
        {
          alive: () => false,
          env: Option.some("tester"),
          pane: Option.none(),
          pid: 1,
          reads: true,
          session: "thread-fixture",
        },
        (message, _settled, ack) =>
          Effect.gen(function* receiveFixture() {
            received.push(message);

            if (ack !== undefined) {
              yield* ack.pipe(Effect.forkIn(scope));
            }
          })
      );
      yield* Deferred.await(completed).pipe(Effect.timeout("5 seconds"));
    }).pipe(
      Effect.provide(
        harness(state, http, [], settings).pipe(
          Layer.provideMerge(sockets(envelopes.length))
        )
      )
    );

    return { finalId, outgoing, received };
  }
);
