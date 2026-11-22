import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as AttentionReceipt from "@rat-king/lexicon/attention.receipt";
import * as AttentionStatus from "@rat-king/lexicon/attention.status";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import type { LexMap } from "@rat-king/lexicon/runtime";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { Directory } from "@rat-king/ratking-client/directory";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  defaultPreferences,
  defaultStatus,
} from "../../mailbox-client/src/attention.ts";
import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { harness } from "./harness.ts";

const TaggedMessageEvent = Schema.Struct({
  $type: Schema.Literal("sh.mschf.ratking.defs#messageEvent"),
  ...Defs.MessageEvent.schema.fields,
});

const endpoint = "https://mailbox.example.invalid";

const serviceDid = "did:web:mailbox.example.invalid";

it.live.prop(
  "A preferences receipt refreshes levers; forward sends a signed encrypted copy and leaves original display custody intact",
  [Schema.String],
  ([body]) =>
    Effect.gen(function* readerProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const peer = yield* identity("did:web:peer.agents.example.invalid");
      const copy = yield* identity("did:web:copy.agents.example.invalid");
      const peerDoc = yield* document(peer);
      const copyDoc = yield* document(copy);
      const sockets: EventTarget[] = [];

      const events: (
        | typeof TaggedMessageEvent.Type
        | AttentionReceipt.MainValue
      )[] = [];

      const displayed = yield* Deferred.make<Inbound>();
      const forwarded = yield* Deferred.make<Defs.EncryptedEnvelopeValue>();
      const live = yield* Deferred.make<boolean>();
      let prefs = defaultPreferences();
      let acks = 0;
      let originalId = "3mxjs56afmy5b";
      let acknowledge = Effect.void;

      const socket = Layer.succeed(WebSocketPort, {
        connect: () => {
          const target = new EventTarget();
          sockets.push(target);

          return {
            addEventListener: target.addEventListener.bind(target),
            close: () => {},
            readyState: 1,
            removeEventListener: target.removeEventListener.bind(target),
            send: () => {
              queueMicrotask(() => {
                target.dispatchEvent(
                  new MessageEvent("message", {
                    data: JSON.stringify({ seq: events.length }),
                  })
                );
              });
            },
          };
        },
      });

      const http = HttpClient.make((request) =>
        Effect.gen(function* mailbox() {
          const nsid = new URL(request.url).pathname.replace("/xrpc/", "");
          let output: LexMap;

          const text = Predicate.isTagged(request.body, "Uint8Array")
            ? new TextDecoder().decode(request.body.body)
            : "{}";

          switch (nsid) {
            case "sh.mschf.ratking.attention.getPreferences": {
              output = { prefs };
              break;
            }

            case "sh.mschf.ratking.attention.getStatus": {
              output = {
                status: yield* Schema.encodeEffect(AttentionStatus.Main)(
                  defaultStatus()
                ),
              };
              break;
            }

            case "sh.mschf.ratking.runtime.acquireLease": {
              const input = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({ did: Schema.String, harness: Schema.Json })
                )
              )(text);

              yield* Deferred.succeed(live, true);
              output = {
                lease: {
                  did: input.did,
                  expiresAt: DateTime.formatIso(
                    DateTime.makeUnsafe(
                      (yield* Clock.currentTimeMillis) + 300_000
                    )
                  ),
                  generation: 1,
                  harness: input.harness,
                  issuedAt: "2026-01-01T00:00:00.000Z",
                  leaseId: "3mxjs56afmy5a",
                },
              };
              break;
            }

            case "sh.mschf.ratking.mailbox.list": {
              const after = Number(
                new URL(request.url).searchParams.get("afterSeq") ?? 0
              );

              output = yield* Schema.encodeEffect(List.Output)({
                events: events.filter((event) => event.seq > after),
                throughSeq: events.length,
              });
              break;
            }

            case "sh.mschf.ratking.mailbox.send": {
              const input = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({ envelope: Defs.EncryptedEnvelope })
                )
              )(text);

              yield* Deferred.succeed(forwarded, input.envelope);
              output = {
                receipt: {
                  message: {
                    messageId: input.envelope.aad.messageId,
                    senderDid: input.envelope.aad.senderDid,
                  },
                  recipientDid: input.envelope.aad.recipientDid,
                  seq: 3,
                  state: "accepted",
                },
              };
              break;
            }

            case "sh.mschf.ratking.mailbox.ack": {
              acks += 1;
              output = {
                receipt: {
                  message: { messageId: originalId, senderDid: peer.did },
                  recipientDid: "did:web:tester.agents.example.invalid",
                  seq: 4,
                  state: "acked",
                },
              };
              break;
            }

            case "sh.mschf.ratking.mailbox.deliver": {
              output = {
                receipt: {
                  message: { messageId: originalId, senderDid: peer.did },
                  recipientDid: "did:web:tester.agents.example.invalid",
                  seq: 3,
                  state: "delivered",
                },
              };
              break;
            }

            default: {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "MailboxUnavailable" }, { status: 503 })
              );
            }
          }

          return HttpClientResponse.fromWeb(request, Response.json(output));
        }).pipe(Effect.orDie)
      );

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;
        yield* directory.record("peer", peerDoc);
        yield* directory.record("copy/desk", copyDoc);
        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            owner: Option.some("peer"),
            pane: Option.none(),
            pid: 1,
            session: "attention",
          },
          (inbound, _settled, ack) => {
            if ("record" in inbound) {
              return Effect.void;
            }

            acknowledge = ack ?? Effect.void;

            return Deferred.succeed(displayed, inbound).pipe(Effect.asVoid);
          }
        );
        yield* Deferred.await(live).pipe(Effect.timeout("5 seconds"));
        const tester = yield* directory.resolve("tester");

        const sending = yield* prepare({
          endpoint,
          own: yield* ownIdentity(peer),
          peers: [tester.document],
          serviceDid,
        });

        const envelope = yield* sending.seal(
          tester.did,
          () =>
            Schema.encodeSync(PayloadJson)({
              body,
              cc: [],
              from: "peer",
              quiet: true,
              thread: "incident",
              to: "tester",
            }),
          { encrypt: true }
        );

        originalId = envelope.aad.messageId;
        prefs = { ...defaultPreferences(), forward: ["copy/desk"] };
        events.push(
          yield* Schema.decodeUnknownEffect(AttentionReceipt.Main)({
            $type: "sh.mschf.ratking.attention.receipt",
            operation: "putPreferences",
            seq: 1,
          }),
          yield* Schema.decodeUnknownEffect(Schema.toType(TaggedMessageEvent))({
            $type: "sh.mschf.ratking.defs#messageEvent",
            envelope,
            receipt: {
              message: {
                messageId: envelope.aad.messageId,
                senderDid: peer.did,
              },
              recipientDid: tester.did,
              seq: 2,
              state: "accepted",
            },
            seq: 2,
          })
        );

        for (const target of sockets) {
          target.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ seq: 2 }) })
          );
        }

        const original = yield* Deferred.await(displayed).pipe(
          Effect.timeout("5 seconds")
        );

        expect(original.from).toBe("peer");
        expect(original.body).toBe(body);
        expect(original.quiet).toBe(true);
        expect(original.copy).toBe(false);
        expect(original.digestMinutes).toBeUndefined();
        expect(original.levers?.prefs?.forward).toEqual(["copy/desk"]);
        expect(original.levers?.owner).toBe("peer");
        expect(acks).toBe(0);

        const copied = yield* Deferred.await(forwarded).pipe(
          Effect.timeout("5 seconds")
        );

        expect(copied.aad.senderDid).toBe(tester.did);
        expect(copied.aad.recipientDid).toBe(copy.did);

        const receiving = yield* prepare({
          endpoint,
          own: yield* ownIdentity(copy),
          peers: [tester.document],
          serviceDid,
        });

        const opened = yield* receiving.open(copied);
        expect(opened.verified).toBe(true);
        expect(opened.encrypted).toBe(true);

        const payload = yield* Schema.decodeUnknownEffect(PayloadJson)(
          opened.body
        );

        expect(payload.from).toBe("tester");
        expect(payload.to).toBe("tester");
        expect(payload.cc).toEqual(["copy/desk"]);
        expect(payload.body).toContain(body);
        yield* acknowledge;
        expect(acks).toBe(1);
      }).pipe(
        Effect.provide(
          Layer.merge(
            harness(state, http, [], {
              attentionLevers: true,
              ccDigestMinutes: { tester: 15 },
            }),
            socket
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 }, timeout: 30_000 }
);
