/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- fast-check model runner is a Promise boundary. */
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import {
  RatKingMailbox,
  layer,
  WebSocketPort,
  MailboxClientError,
} from "@rat-king/mailbox-client";
import type { LeaseFence } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { BarrierSocket } from "./barrier-socket.ts";
import { celldNode, identity, document } from "./helpers.ts";

const Step = Schema.Struct({
  action: Schema.Literals(["send", "drop", "reconnect", "ack", "bump"]),
  body: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)
  ),
  urgent: Schema.Boolean,
});

const Steps = Schema.Array(Step).check(
  Schema.isMinLength(5),
  Schema.isMaxLength(15)
);

class ModelFailure extends Schema.TaggedError<ModelFailure>()("ModelFailure", {
  message: Schema.String,
}) {}

interface Expected {
  readonly body: string;
  readonly urgent: boolean;
  readonly senderDid: string;
}

type ModelStep =
  | typeof Step.Type
  | { action: "expiry" | "register"; body: string; urgent: boolean };

interface Model {
  readonly sent: Map<string, Expected>;
  readonly acked: Set<string>;
}

const binary = process.env.RAT_KING_CELLD;

if (binary === undefined) {
  it.skip("push checkpoints emit every message exactly once (requires RAT_KING_CELLD)", () => {});
} else {
  it.live.prop(
    "push checkpoints emit every message exactly once across drops, reconnects, ack and mid-batch generation changes",
    { steps: Arbitrary.schema(Steps) },
    ({ steps }) =>
      Effect.gen(function* modelProof() {
        if (binary === undefined) {
          return;
        }

        const sender = yield* identity("did:web:sender.example.invalid");
        const recipient = yield* identity("did:web:recipient.example.invalid");

        const staticDocuments = [
          yield* document(sender),
          yield* document(recipient),
        ];

        const registered = yield* identity(
          "did:web:registered.example.invalid"
        );

        const registeredDocument = yield* document(registered);
        const documents = [...staticDocuments, registeredDocument];

        const endpoint = yield* celldNode(
          binary,
          JSON.stringify(staticDocuments),
          sender.did
        );

        const serviceDid = "did:web:service.example";

        const senderContext = yield* Layer.build(
          layer({ documents, endpoint, identity: sender, serviceDid }).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        );

        const recipientContext = yield* Layer.build(
          layer({ documents, endpoint, identity: recipient, serviceDid }).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        );

        const registeredContext = yield* Layer.build(
          layer({ documents, endpoint, identity: registered, serviceDid }).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        );

        const registeredClient = Context.get(registeredContext, RatKingMailbox);
        const sending = Context.get(senderContext, RatKingMailbox);
        const receiving = Context.get(recipientContext, RatKingMailbox);
        const scope = yield* Effect.scope;
        const context = yield* Effect.context();
        const batches = yield* Queue.unbounded<boolean>();
        const connected = yield* Queue.unbounded<boolean>();
        const authSent = yield* Queue.unbounded<boolean>();
        const batchEntered = yield* Queue.unbounded<boolean>();
        let holdNext = false;
        const gate = yield* Latch.make(true);
        const emitted = new Map<string, Expected>();
        const counts = new Map<string, number>();
        const messages = new Map<string, Defs.MessageRefValue>();
        const sockets: BarrierSocket[] = [];
        let checkpoint = 0;

        let fence: LeaseFence = yield* receiving.lease.acquire({
          did: recipient.did,
          expiresAt: DateTime.formatIso(
            DateTime.add(yield* DateTime.now, { minutes: 5 })
          ),
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId: "client-model",
          },
        });

        const start = () =>
          receiving.watch(checkpoint, fence).pipe(
            Stream.provideService(WebSocketPort, {
              connect: (url) => {
                const parsed = new URL(url);
                expect([...parsed.searchParams.keys()].toSorted()).toEqual([
                  "generation",
                  "leaseId",
                  "recipientDid",
                ]);
                expect(url).not.toContain("token");
                const held = holdNext;
                holdNext = false;

                const socket = new BarrierSocket(url, held, () => {
                  Queue.offerUnsafe(authSent, true);
                });

                socket.addEventListener(
                  "open",
                  () => {
                    Queue.offerUnsafe(connected, true);
                  },
                  { once: true }
                );
                sockets.push(socket);

                return socket;
              },
            }),
            Stream.runForEach((batch) =>
              Effect.andThen(
                Queue.offer(batchEntered, true),
                gate.whenOpen(
                  Effect.gen(function* consume() {
                    for (const event of batch.events) {
                      if (Schema.is(Schema.toType(Defs.MessageEvent))(event)) {
                        const opened = yield* receiving.open(event.envelope);
                        emitted.set(opened.tid, {
                          body: opened.body,
                          senderDid: opened.senderDid,
                          urgent: opened.urgent === true,
                        });
                        counts.set(
                          opened.tid,
                          (counts.get(opened.tid) ?? 0) + 1
                        );
                        messages.set(
                          opened.tid,
                          yield* Schema.decodeUnknownEffect(
                            Schema.toType(Defs.MessageRef)
                          )({
                            messageId: opened.tid,
                            senderDid: opened.senderDid,
                          })
                        );
                      }
                    }

                    checkpoint = batch.throughSeq;
                    yield* Queue.offer(batches, true);
                  })
                )
              )
            ),
            Effect.forkIn(scope)
          );

        const stateModel: Model = { acked: new Set(), sent: new Map() };

        for (let index = 0; index < 55; index += 1) {
          const body = `backlog ${index}`;
          const urgent = index % 2 === 0;

          const output = yield* sending.send(
            recipient.did,
            body,
            urgent ? { urgent: true } : {}
          );

          stateModel.sent.set(output.receipt.message.messageId, {
            body,
            senderDid: sender.did,
            urgent,
          });
        }

        let watcher = yield* start();
        yield* Queue.take(connected);

        const assertModel = (model: Model) => {
          expect(
            [...emitted.entries()].toSorted(([left], [right]) =>
              left.localeCompare(right)
            )
          ).toEqual(
            [...model.sent.entries()].toSorted(([left], [right]) =>
              left.localeCompare(right)
            )
          );
          expect([...counts.values()].every((count) => count === 1)).toBe(true);
        };

        const sync = (model: Model) =>
          Effect.gen(function* synchronize() {
            const watermark = (yield* receiving.poll(checkpoint)).throughSeq;

            let observed = checkpoint;

            while (observed < watermark) {
              yield* Queue.take(batches);
              observed = checkpoint;
            }

            assertModel(model);
          }).pipe(Effect.timeout("10 seconds"));

        const send = (model: Model, body: string, urgent: boolean) =>
          Effect.gen(function* sendMessage() {
            const output = yield* sending.send(
              recipient.did,
              body,
              urgent ? { urgent: true } : {}
            );

            model.sent.set(output.receipt.message.messageId, {
              body,
              senderDid: sender.did,
              urgent,
            });
          });

        const appendBeforeReady = (model: Model) =>
          Effect.gen(function* appendDuringHandshake() {
            yield* Queue.take(authSent).pipe(Effect.timeout("10 seconds"));
            const beforeReady = checkpoint;
            yield* send(model, "append after auth before ready", true);
            expect(checkpoint).toBe(beforeReady);
            const socket = sockets.at(-1);

            if (socket !== undefined) {
              socket.release();
            }
          });

        const reconnect = () =>
          Effect.gen(function* reconnectWatcher() {
            yield* Fiber.interrupt(watcher);
            holdNext = true;
            watcher = yield* start();
            yield* Queue.take(connected);
            yield* appendBeforeReady(stateModel);
          });

        const bump = (model: Model) =>
          Effect.gen(function* bumpGeneration() {
            yield* Queue.clear(batchEntered);
            yield* gate.close;
            yield* send(model, "generation batch one", true);
            yield* send(model, "generation batch two", false);
            yield* send(model, "generation batch three", true);
            yield* Queue.take(batchEntered).pipe(Effect.timeout("10 seconds"));
            const oldGeneration = fence.generation;
            const oldSocketCount = sockets.length;
            yield* receiving.lease.release(fence);
            fence = yield* receiving.lease.acquire({
              did: recipient.did,
              expiresAt: DateTime.formatIso(
                DateTime.add(yield* DateTime.now, { minutes: 5 })
              ),
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                sessionId: "client-model",
              },
            });
            expect(fence.generation).toBeGreaterThan(oldGeneration);
            yield* gate.open;

            const exit = yield* Fiber.await(watcher).pipe(
              Effect.timeout("10 seconds")
            );

            const failure = Exit.findError(exit);
            expect(Result.isSuccess(failure)).toBe(true);

            if (Result.isSuccess(failure)) {
              expect(failure.success).toMatchObject({ error: "LeaseMismatch" });
            }

            expect(sockets.length).toBe(oldSocketCount);
            expect(sockets.at(-1)?.readyState).toBe(WebSocket.CLOSED);
            holdNext = true;
            watcher = yield* start();
            yield* Queue.take(connected);
            yield* appendBeforeReady(model);
          });

        const expire = (model: Model) =>
          Effect.gen(function* expireLease() {
            const renewed = yield* receiving.lease.renew({
              ...fence,
              expiresAt: DateTime.formatIso(
                DateTime.add(yield* DateTime.now, { seconds: 1 })
              ),
            });

            const deadline = DateTime.toEpochMillis(
              DateTime.makeUnsafe(renewed.expiresAt)
            );

            yield* Effect.sleep(
              Math.max(0, deadline - (yield* Clock.currentTimeMillis)) + 1
            );
            const previousGeneration = fence.generation;
            const socketCount = sockets.length;
            yield* send(model, "append after lease expiry", true);

            const exit = yield* Fiber.await(watcher).pipe(
              Effect.timeout("10 seconds")
            );

            const failure = Exit.findError(exit);
            expect(Result.isSuccess(failure)).toBe(true);

            if (Result.isSuccess(failure)) {
              expect(failure.success).toMatchObject({ error: "LeaseMismatch" });
            }

            expect(sockets.length).toBe(socketCount);
            expect(sockets.at(-1)?.readyState).toBe(WebSocket.CLOSED);
            fence = yield* receiving.lease.acquire({
              did: recipient.did,
              expiresAt: DateTime.formatIso(
                DateTime.add(yield* DateTime.now, { minutes: 5 })
              ),
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                sessionId: "client-model",
              },
            });
            expect(fence.generation).toBeGreaterThan(previousGeneration);
            holdNext = true;
            watcher = yield* start();
            yield* Queue.take(connected);
            yield* appendBeforeReady(model);
          });

        const register = (model: Model, body: string, urgent: boolean) =>
          Effect.gen(function* registerRoundTrip() {
            expect(yield* sending.putDidDocument(registeredDocument)).toEqual({
              did: registered.did,
            });
            expect(yield* sending.putDidDocument(registeredDocument)).toEqual({
              did: registered.did,
            });

            const sent = yield* registeredClient.send(
              recipient.did,
              body,
              urgent ? { urgent: true } : {}
            );

            model.sent.set(sent.receipt.message.messageId, {
              body,
              senderDid: registered.did,
              urgent,
            });

            const inbound = yield* sending.send(
              registered.did,
              body,
              urgent ? { urgent: true } : {}
            );

            const page = yield* registeredClient.poll(0);

            const found = page.events.find(
              (event) =>
                Schema.is(Schema.toType(Defs.MessageEvent))(event) &&
                event.receipt.message.messageId ===
                  inbound.receipt.message.messageId
            );

            expect(found).toBeDefined();

            if (
              found !== undefined &&
              Schema.is(Schema.toType(Defs.MessageEvent))(found)
            ) {
              const opened = yield* registeredClient.open(found.envelope);
              expect(opened.body).toBe(body);
              expect(opened.senderDid).toBe(sender.did);
              expect(opened.urgent === true).toBe(urgent);
              expect(opened.verified).toBe(true);
            }
          });

        const command = (step: ModelStep): AsyncCommand<Model, undefined> => ({
          check: () => true,
          run: (model) => {
            const operation = Effect.gen(function* stepCommand() {
              switch (step.action) {
                case "expiry": {
                  yield* expire(model);
                  break;
                }

                case "register": {
                  yield* register(model, step.body, step.urgent);
                  break;
                }

                case "send": {
                  yield* send(model, step.body, step.urgent);
                  break;
                }

                case "drop": {
                  yield* Fiber.interrupt(watcher);
                  holdNext = true;
                  watcher = yield* start();
                  yield* Queue.take(connected);
                  yield* Queue.take(authSent);
                  yield* send(
                    model,
                    "append then drop before readiness",
                    false
                  );
                  const socket = sockets.at(-1);

                  if (socket !== undefined) {
                    socket.close(1000, "model drop");
                  }

                  yield* Queue.take(connected).pipe(
                    Effect.timeout("10 seconds")
                  );
                  break;
                }

                case "reconnect": {
                  yield* reconnect();
                  break;
                }

                case "bump": {
                  yield* bump(model);
                  break;
                }

                case "ack": {
                  const entry = [...messages.entries()].find(
                    ([messageId]) => !model.acked.has(messageId)
                  );

                  const ref = entry?.[1];

                  if (ref !== undefined) {
                    const input = {
                      generation: fence.generation,
                      leaseId: fence.leaseId,
                      message: ref,
                    };

                    yield* receiving.deliver(input);
                    yield* receiving.ack(input);
                    model.acked.add(ref.messageId);
                  }

                  break;
                }

                default: {
                  const exhaustive: never = step;

                  return exhaustive;
                }
              }

              return yield* sync(model);
            });

            // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun requires a Promise per command; reuse the live test context.
            return Effect.runPromiseWith(context)(
              operation.pipe(
                Effect.timeout("15 seconds"),
                Effect.mapError(
                  (error) =>
                    new ModelFailure({
                      message: Schema.is(MailboxClientError)(error)
                        ? `${step.action}: ${error.error ?? "ClientError"} (${error.status ?? 0}) ${error.reason}`
                        : `${step.action}: ${String(error)}`,
                    })
                )
              )
            );
          },
          toString: () => step.action,
        });

        yield* sync(stateModel);

        const required = [
          "send",
          "drop",
          "reconnect",
          "ack",
          "bump",
          "expiry",
          "register",
        ] as const;

        yield* Effect.tryPromise({
          catch: (cause) => new ModelFailure({ message: String(cause) }),
          try: () =>
            asyncModelRun(
              () => ({ model: stateModel, real: undefined }),
              [
                ...required.map((action) =>
                  command({ action, body: "required message", urgent: true })
                ),
                ...steps.map(command),
              ]
            ),
        });
        yield* reconnect();
        yield* sync(stateModel);
        yield* Fiber.interrupt(watcher);
        yield* receiving.lease.release(fence);
      }),
    { arbitrary: { maxShrinks: 5, runs: 5 }, timeout: 120_000 }
  );
}
