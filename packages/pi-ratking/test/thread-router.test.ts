import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as List from "@rat-king/lexicon/mailbox.list";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { Directory } from "@rat-king/ratking-client/directory";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import {
  ThreadForward,
  ThreadJournal,
} from "@rat-king/ratking-client/thread-routing";
import {
  Arbitrary,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { fakeMailbox } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

const socket = Layer.succeed(WebSocketPort, {
  connect: () => {
    const target = new EventTarget();

    return {
      addEventListener: (type, listener, options) => {
        target.addEventListener(type, listener, options);
      },
      close: () => {},
      readyState: 1,
      removeEventListener: (type, listener) => {
        target.removeEventListener(type, listener);
      },
      send: () => {
        queueMicrotask(() => {
          target.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ seq: 3 }) })
          );
        });
      },
    };
  },
});

const Case = Schema.Struct({
  encrypted: Schema.Boolean,
  fail: Schema.Literals(["none", "reject", "retired"]),
  quiet: Schema.Boolean,
});

it.live.prop(
  "receiver consumes signed claims, persists both owners, reseals every forward and keeps a quiet copy; partial admission and retired owners fail open to a router wake",
  [Arbitrary.schema(Case)],
  ([sample]) =>
    Effect.gen(function* receiverProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const mailbox = fakeMailbox("accept");
      const tester = yield* identity("did:web:tester.agents.example.invalid");
      const alpha = yield* identity("did:web:alpha.agents.example.invalid");
      const beta = yield* identity("did:web:beta.agents.example.invalid");
      const sender = yield* identity("did:web:sender.agents.example.invalid");

      const documents = [
        yield* document(tester),
        yield* document(alpha),
        yield* document(beta),
        yield* document(sender),
      ];

      const root = "3m7x2ka4xv22a";

      const seal = (
        peer: typeof tester,
        body: string | ((id: string) => string)
      ) =>
        Effect.gen(function* sealInbound() {
          const client = yield* prepare({
            endpoint: "https://mailbox.example.invalid",
            own: yield* ownIdentity(peer),
            peers: documents,
            serviceDid: "did:web:mailbox.example.invalid",
          });

          return yield* client.seal(tester.did, body, {
            encrypt: sample.encrypted,
          });
        }).pipe(
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, mailbox.http)
        );

      const claim = JSON.stringify({
        $type: "sh.mschf.ratking.thread#control",
        op: "claim",
        thread: root,
      });

      const envelopes = [
        yield* seal(alpha, claim),
        yield* seal(beta, claim),
        yield* seal(sender, () => {
          const payload = {
            body: "follow-up",
            from: "sender",
            thread: root,
            to: "tester",
          };

          if (sample.quiet) {
            Object.assign(payload, { quiet: true });
          }

          return Schema.encodeSync(PayloadJson)(payload);
        }),
      ];

      const delivered = yield* Deferred.make<Inbound>();
      let acquired = false;

      const http = HttpClient.make((request) =>
        Effect.gen(function* receiveAndForward() {
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
                            recipientDid: tester.did,
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

          if (nsid.endsWith(".ack") || nsid.endsWith(".deliver")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                receipt: {
                  message: { messageId: root, senderDid: sender.did },
                  recipientDid: tester.did,
                  seq: 3,
                  state: nsid.endsWith(".ack") ? "acked" : "delivered",
                },
              })
            );
          }

          const response = yield* mailbox.http.execute(request);

          if (
            nsid.endsWith(".send") &&
            Predicate.isTagged(request.body, "Uint8Array")
          ) {
            const envelope = mailbox.requests.at(-1);

            if (
              envelope?.aad.recipientDid === beta.did &&
              sample.fail !== "none"
            ) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  {
                    error: sample.fail === "retired" ? "Retired" : "Forbidden",
                    message: "owner unavailable",
                  },
                  { status: sample.fail === "retired" ? 410 : 403 }
                )
              );
            }
          }

          return response;
        }).pipe(Effect.orDie)
      );

      yield* Effect.gen(function* checkReceiver() {
        const directory = yield* Directory;
        const secrets = yield* SecretStore;
        const ratking = yield* RatKing;

        yield* secrets.add(
          "rat_king_fleet_agent_tester_identity",
          Redacted.make(JSON.stringify(tester))
        );

        for (const [index, name] of [
          "tester",
          "alpha",
          "beta",
          "sender",
        ].entries()) {
          const peer = documents[index];

          if (peer !== undefined) {
            yield* directory.record(name, peer);
          }
        }

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            reads: true,
            session: "thread-router",
          },
          (message) =>
            "body" in message
              ? Deferred.succeed(delivered, message).pipe(Effect.asVoid)
              : Effect.void
        );

        const copy = yield* Deferred.await(delivered).pipe(
          Effect.timeout("5 seconds")
        );

        expect(copy.id).toBe(envelopes[2]?.aad.messageId);
        expect(copy.routedCopy === true).toBe(sample.fail === "none");
        expect(copy.routedWake === true).toBe(sample.fail !== "none");
        expect(mailbox.requests).toHaveLength(2);

        const owners = yield* fs
          .readFileString(`${state}/thread-routing/tester.json`)
          .pipe(
            Effect.flatMap(
              Schema.decodeEffect(Schema.fromJsonString(ThreadJournal))
            )
          );

        expect(owners[0]?.owners.map((owner) => owner.name).toSorted()).toEqual(
          ["alpha", "beta"]
        );

        for (const envelope of mailbox.requests) {
          const peer = envelope.aad.recipientDid === alpha.did ? alpha : beta;

          const client = yield* prepare({
            endpoint: "https://mailbox.example.invalid",
            own: yield* ownIdentity(peer),
            peers: documents,
            serviceDid: "did:web:mailbox.example.invalid",
          });

          const opened = yield* client.open(envelope);

          const forward = yield* Schema.decodeEffect(
            Schema.fromJsonString(ThreadForward)
          )(opened.body);

          expect(opened.encrypted).toBe(sample.encrypted);
          expect(forward.original).toMatchObject({
            body: "follow-up",
            did: sender.did,
            from: "sender",
            id: copy.id,
          });
          expect(forward.thread).toBe(root);
          expect(forward.delivery?.quiet === true).toBe(sample.quiet);
        }
      }).pipe(
        Effect.provide(
          harness(state, http, [], {
            threadRouting: [{ name: "tester", senders: ["sender"] }],
          }).pipe(Layer.provideMerge(socket))
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 30_000 }
);
