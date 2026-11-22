import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { attend, formatReason } from "@rat-king/ratking-client/attend";
import type { Arrival } from "@rat-king/ratking-client/attend";
import { Directory } from "@rat-king/ratking-client/directory";
import type { Resolved } from "@rat-king/ratking-client/directory";
import { PayloadJson, renderInbound } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { injects, inboundDetails } from "../src/extension.ts";
import { applyDelivery, verdictToHold } from "../src/pending.ts";
import type { Hold } from "../src/pending.ts";
import { runAction } from "../src/tool.ts";
import { harness } from "./harness.ts";

const deliveryMode = (arrival: Arrival) =>
  applyDelivery<Hold>(
    verdictToHold(attend(arrival, {}, 0, undefined, Option.none())),
    {
      inject: (hold) => hold,
      settle: () => {
        throw new Error("Intent cannot settle");
      },
    }
  );

const endpoint = "https://mailbox.example.invalid";

const serviceDid = "did:web:mailbox.example.invalid";

const facts = {
  alive: () => false,
  env: Option.some("tester"),
  pane: Option.none(),
  pid: 1,
  session: "async",
};

it.live.prop(
  "fake mailbox: async receipt precedes reply, restart lists it, overdue nudge is quiet once and ack closes the late reply",
  [Schema.String, Schema.Boolean, Schema.Boolean],
  ([summary, blocking, modern]) =>
    Effect.forEach(
      ["acked", "expired", "delegated"] as const,
      (outcome) =>
        Effect.gen(function* mailboxProof() {
          const fs = yield* FileSystem.FileSystem;
          const state = yield* fs.makeTempDirectoryScoped();
          const peer = yield* identity("did:web:peer.agents.example.invalid");
          const peerDocument = yield* document(peer);
          const secrets = new Map<string, string>();
          const sockets: EventTarget[] = [];
          const sends: Defs.EncryptedEnvelopeValue[] = [];
          let event: Defs.MessageEventValue | undefined;
          let acks = 0;
          let head = 0;
          let generation = 0;
          const output = yield* Deferred.make<Inbound>();
          const secondSent = yield* Deferred.make<boolean>();
          const secondDisplayed = yield* Deferred.make<boolean>();

          const notice = (target: EventTarget) =>
            target.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({ seq: head }),
              })
            );

          const socket = Layer.succeed(WebSocketPort, {
            connect: () => {
              const target = new EventTarget();
              sockets.push(target);

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
                    notice(target);
                  });
                },
              };
            },
          });

          const http = HttpClient.make((request) =>
            Effect.gen(function* mailbox() {
              const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

              const body = Predicate.isTagged(request.body, "Uint8Array")
                ? new TextDecoder().decode(request.body.body)
                : "{}";

              if (nsid.endsWith(".acquireLease")) {
                const input = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ did: Schema.String, harness: Schema.Json })
                  )
                )(body);

                generation += 1;

                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    lease: {
                      did: input.did,
                      expiresAt: DateTime.formatIso(
                        DateTime.makeUnsafe(
                          (yield* Clock.currentTimeMillis) + 300_000
                        )
                      ),
                      generation,
                      harness: input.harness,
                      leaseId: "3mxcx45mn7sex",
                    },
                  })
                );
              }

              if (nsid.endsWith(".list")) {
                const after = Number(
                  new URL(request.url).searchParams.get("afterSeq") ?? 0
                );

                const batch = yield* Schema.decodeUnknownEffect(
                  Schema.toType(List.Output)
                )({
                  events: event !== undefined && after < head ? [event] : [],
                  throughSeq: head,
                });

                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    yield* Schema.encodeEffect(
                      Schema.fromJsonString(List.Output)
                    )(batch),
                    { headers: { "content-type": "application/json" } }
                  )
                );
              }

              if (nsid.endsWith(".send")) {
                const input = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ envelope: Defs.EncryptedEnvelope })
                  )
                )(body);

                sends.push(input.envelope);

                if (sends.length === 2) {
                  yield* Deferred.succeed(secondSent, true);
                }

                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    receipt: {
                      message: {
                        messageId: input.envelope.aad.messageId,
                        senderDid: input.envelope.aad.senderDid,
                      },
                      recipientDid: peer.did,
                      seq: sends.length,
                      state: "accepted",
                    },
                  })
                );
              }

              if (
                (nsid.endsWith(".deliver") || nsid.endsWith(".ack")) &&
                event !== undefined
              ) {
                let receiptState = "delivered";

                if (nsid.endsWith(".ack")) {
                  acks += 1;
                  receiptState =
                    head === 1 && outcome === "expired" ? "expired" : "acked";
                }

                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    receipt: {
                      ...event.receipt,
                      state: receiptState,
                    },
                  })
                );
              }

              if (nsid.endsWith(".releaseLease")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ released: true })
                );
              }

              return HttpClientResponse.fromWeb(
                request,
                Response.json({ error: "MailboxUnavailable" }, { status: 503 })
              );
            }).pipe(Effect.orDie)
          );

          const layer = harness(state, http, [], {
            relays: [
              {
                fallbackMinutes: 10,
                mode: "front",
                name: "tester",
                to: "peer",
              },
            ],
            secrets,
          }).pipe(Layer.provideMerge(socket));

          const begin = (
            king: RatKing["Service"],
            deliver: Parameters<RatKing["Service"]["run"]>[1]
          ) =>
            Effect.gen(function* startReader() {
              const directory = yield* Directory;
              yield* directory.record("peer", peerDocument);
              const live = yield* Deferred.make<boolean>();
              yield* king.run(
                {
                  ...facts,
                  onState: (reader) => {
                    if (ReaderState.$is("Live")(reader)) {
                      Deferred.doneUnsafe(live, Effect.succeed(true));
                    }
                  },
                },
                deliver
              );
              yield* Deferred.await(live);
            });

          let askId = "";
          let receiverDocument: Resolved["document"] = peerDocument;
          yield* Effect.gen(function* firstPi() {
            const king = yield* RatKing;
            yield* begin(king, () => Effect.die("No reply exists yet"));

            const result = yield* runAction("ratking", 1, {
              action: "ask",
              dueBy: 0,
              message: "question",
              summary,
              timeoutSeconds: 1,
              to: "peer",
              wait: blocking,
            });

            if (blocking) {
              expect(result.isError).toBe(true);
              expect(result.text).toContain("NoReply");
            } else {
              expect(result.text).toContain("✓ asked peer");
            }

            askId = sends[0]?.aad.messageId ?? "";
            expect(askId).not.toBe("");
            expect(yield* king.pending).toHaveLength(1);
            const directory = yield* Directory;
            receiverDocument = (yield* directory.resolve("tester")).document;
          }).pipe(Effect.scoped, Effect.provide(layer));
          let nudgeCount = 0;
          let waiting = false;
          let ack: Effect.Effect<void> = Effect.void;
          yield* Effect.gen(function* restartedPi() {
            const king = yield* RatKing;
            yield* begin(king, (inbound, settled, acknowledgment) =>
              Effect.gen(function* display() {
                if ("record" in inbound) {
                  return;
                }

                if (inbound.noReply === true) {
                  nudgeCount += 1;
                  expect(deliveryMode(inbound)).toBe("nextTurn");

                  return;
                }

                expect(settled).toBe(waiting);
                expect(injects(inbound, settled)).toBe(!waiting);

                if (waiting || outcome !== "delegated") {
                  expect(deliveryMode(inbound)).toBe("steer");
                  expect(
                    formatReason(inboundDetails(inbound, settled).reason)
                  ).toBe("woken: reply");
                }

                expect(renderInbound("ratking", inbound)).toContain(
                  `answer to your ask ${askId}`
                );
                expect(inbound.askSummary).toBe(
                  summary.trim().replaceAll(/\s+/gu, " ").slice(0, 280)
                );
                ack = acknowledgment ?? Effect.die("No display acknowledgment");

                if (waiting) {
                  yield* Deferred.succeed(secondDisplayed, true);
                }

                yield* Deferred.succeed(output, inbound);
              })
            );

            const pending = yield* runAction("ratking", 1, {
              action: "pending",
            });

            expect(pending.text).toContain("Outbound open asks");
            expect(pending.text).toContain(askId);

            const client = yield* prepare({
              endpoint,
              own: yield* ownIdentity(peer),
              peers: [receiverDocument],
              serviceDid,
            });

            const answer = Effect.gen(function* answerAsk() {
              const envelope = yield* client.seal(
                receiverDocument.id,
                () => {
                  const payload = {
                    body: "answer",
                    from: "peer",
                    kind: "reply" as const,
                    quiet: true as const,
                    replyTo: modern ? "ignored-legacy-parent" : askId,
                    thread: askId,
                    to: "tester",
                  };

                  if (modern) {
                    Object.assign(payload, {
                      reply: { parent: askId, root: askId },
                    });
                  }

                  return Schema.encodeSync(PayloadJson)(payload);
                },
                { encrypt: false }
              );

              head += 1;

              const custody =
                head === 1 && outcome === "delegated"
                  ? { delegatedTo: peer.did }
                  : undefined;

              event = yield* Schema.decodeUnknownEffect(
                Schema.toType(Defs.MessageEvent)
              )({
                $type: "sh.mschf.ratking.defs#messageEvent",
                envelope,
                receipt: {
                  message: {
                    messageId: envelope.aad.messageId,
                    senderDid: peer.did,
                  },
                  recipientDid: receiverDocument.id,
                  ...custody,
                  seq: head,
                  state: "accepted",
                },
                seq: head,
              });

              for (const target of sockets) {
                notice(target);
              }
            });

            yield* answer;

            yield* Deferred.await(output).pipe(Effect.timeout("5 seconds"));
            expect(acks).toBe(0);
            expect(yield* king.pending).toHaveLength(1);
            yield* ack;
            expect(acks).toBe(outcome === "delegated" ? 0 : 1);
            expect(yield* king.pending).toHaveLength(0);
            expect(nudgeCount).toBe(1);
            waiting = true;

            const waiter = yield* king
              .ask("peer", "question", "2 seconds", { summary, wait: true })
              .pipe(Effect.forkScoped);

            yield* Deferred.await(secondSent);
            askId = sends[1]?.aad.messageId ?? "";
            yield* answer;
            const result = yield* Fiber.join(waiter);
            yield* Deferred.await(secondDisplayed);
            expect(result.reply?.body).toBe("answer");
            expect(yield* king.pending).toHaveLength(1);
            yield* ack;
            expect(yield* king.pending).toHaveLength(0);
          }).pipe(Effect.scoped, Effect.provide(layer));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { discard: true }
    ),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
