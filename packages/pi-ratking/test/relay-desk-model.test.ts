/* oxlint-disable typescript/promise-function-async -- fast-check model command Promise boundary. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import {
  layer as mailboxLayer,
  ownIdentity,
  prepare,
  RatKingMailbox,
} from "@rat-king/mailbox-client";
import { Directory } from "@rat-king/ratking-client/directory";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import type { Inbound, InboundRecord } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import {
  RelayJournal,
  RelayOutbound,
  RelayRecord,
} from "@rat-king/ratking-client/relay";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { harness } from "./harness.ts";

const Name = Schema.Literals(["person", "carol", "dave", "ea"]);

type NameValue = typeof Name.Type;

const Step = Schema.Struct({
  action: Schema.Literals(["send", "ask", "reply"]),
  cc: Schema.Array(Name).check(Schema.isMaxLength(3)),
  copy: Schema.Literals(["accept", "reject", "stall"]),
  encrypt: Schema.Boolean,
  replyAll: Schema.Boolean,
  to: Name,
});

const Original = Schema.Struct({
  cc: Schema.Array(Schema.Literals(["carol", "dave"])).check(
    Schema.isMaxLength(2)
  ),
  copyOutbound: Schema.Boolean,
});

interface Model {
  copies: number;
  open: boolean;
}

const ENDPOINT = "https://mailbox.example.invalid";

const SERVICE = "did:web:mailbox.example.invalid";

const didOf = (name: string) => `did:web:${name}.agents.example.invalid`;

const unique = (names: readonly string[]) => [...new Set(names)];

const json = (
  request: HttpClientRequest.HttpClientRequest,
  body: typeof Schema.Json.Type,
  status = 200
) => HttpClientResponse.fromWeb(request, Response.json(body, { status }));

const socketPort = Layer.succeed(WebSocketPort, {
  connect: () => {
    const events = new EventTarget();

    return {
      addEventListener: (type, listener, options) => {
        events.addEventListener(type, listener, options);
      },
      close: () => {},
      readyState: 1,
      removeEventListener: (type, listener) => {
        events.removeEventListener(type, listener);
      },
      send: () => {
        queueMicrotask(() => {
          events.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ seq: 1 }) })
          );
        });
      },
    };
  },
});

const until = (check: () => boolean) =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("waiting"))).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    Effect.ignore
  );

it.live.prop(
  "front desk model: reply reaches an original the desk never injected; copyOutbound sends exactly one silent-ready copy per desk send, and a rejected or stalled copy never fails or delays it",
  [Original, Schema.Array(Step).check(Schema.isMaxLength(5))],
  ([original, steps]) =>
    Effect.gen(function* deskModel() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();

      const people = {
        carol: yield* identity(didOf("carol")),
        dave: yield* identity(didOf("dave")),
        ea: yield* identity(didOf("ea")),
        person: yield* identity(didOf("person")),
        tester: yield* identity(didOf("tester")),
      };

      const documents = {
        carol: yield* document(people.carol),
        dave: yield* document(people.dave),
        ea: yield* document(people.ea),
        person: yield* document(people.person),
        tester: yield* document(people.tester),
      };

      const nameOf = new Map(
        Object.keys(people).map((name) => [didOf(name), name])
      );

      const noHttp = HttpClient.make((request) =>
        Effect.die(`Unexpected request ${request.url}`)
      );

      const sealed = yield* Effect.gen(function* sealOriginal() {
        const client = yield* prepare({
          endpoint: ENDPOINT,
          own: yield* ownIdentity(people.person),
          peers: [documents.tester],
          serviceDid: SERVICE,
        });

        return yield* client.seal(
          people.tester.did,
          (id) =>
            Schema.encodeSync(PayloadJson)({
              body: "original",
              cc: original.cc,
              from: "person",
              thread: id,
              to: "tester",
            }),
          { encrypt: true }
        );
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, noHttp)
      );

      const X = sealed.aad.messageId;

      const receipt = {
        message: { messageId: X, senderDid: people.person.did },
        recipientDid: people.tester.did,
        seq: 1,
        state: "accepted",
      };

      const openAs = (
        reader: typeof people.ea,
        envelope: Defs.EncryptedEnvelopeValue
      ) =>
        RatKingMailbox.use((mailbox) => mailbox.open(envelope)).pipe(
          Effect.provide(
            mailboxLayer({
              documents: [documents.tester],
              endpoint: ENDPOINT,
              identity: reader,
              serviceDid: SERVICE,
            })
          ),
          Effect.provideService(HttpClient.HttpClient, noHttp)
        );

      const acked = yield* Deferred.make<boolean>();
      let acquired = false;
      let restarted = false;
      let acknowledgments = 0;
      let copyMode: (typeof Step.Type)["copy"] = "accept";

      const sends: Defs.EncryptedEnvelopeValue[] = [];
      const forwards: (typeof RelayRecord.Type)[] = [];

      const copies: {
        readonly record: typeof RelayOutbound.Type;
        readonly encrypted: boolean;
      }[] = [];

      const leaseUntil = DateTime.formatIso(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300_000)
      );

      const http = HttpClient.make((request) =>
        Effect.gen(function* mailbox() {
          const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

          return yield* Match.value(nsid).pipe(
            Match.when("sh.mschf.ratking.mailbox.list", () =>
              Effect.gen(function* list() {
                const seq = restarted ? 2 : 1;

                const after = Number(
                  new URL(request.url).searchParams.get("afterSeq") ?? 0
                );

                const output = yield* Schema.decodeUnknownEffect(
                  Schema.toType(List.Output)
                )({
                  events:
                    acquired && after < seq
                      ? [
                          {
                            $type: "sh.mschf.ratking.defs#messageEvent",
                            envelope: sealed,
                            receipt: restarted
                              ? { ...receipt, state: "delivered" }
                              : receipt,
                            seq,
                          },
                        ]
                      : [],
                  throughSeq: acquired ? seq : 0,
                });

                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    yield* Schema.encodeEffect(
                      Schema.fromJsonString(List.Output)
                    )(output),
                    { headers: { "content-type": "application/json" } }
                  )
                );
              })
            ),
            Match.when("sh.mschf.ratking.runtime.acquireLease", () =>
              Effect.sync(() => {
                acquired = true;

                return json(request, {
                  lease: {
                    did: people.tester.did,
                    expiresAt: leaseUntil,
                    generation: 1,
                    harness: {
                      $type: "sh.mschf.ratking.runtime.lease#pi",
                      sessionId: "desk",
                    },
                    leaseId: "3mxcx45mn7sex",
                  },
                });
              })
            ),
            Match.when("sh.mschf.ratking.mailbox.deliver", () =>
              Effect.succeed(
                json(request, { receipt: { ...receipt, state: "delivered" } })
              )
            ),
            Match.when("sh.mschf.ratking.mailbox.ack", () =>
              Effect.sync(() => {
                expect(forwards.map((forward) => forward.id)).toEqual([X]);
                acknowledgments += 1;
              }).pipe(
                Effect.andThen(Deferred.succeed(acked, true)),
                Effect.as(
                  json(request, { receipt: { ...receipt, state: "acked" } })
                )
              )
            ),
            Match.when("sh.mschf.ratking.runtime.releaseLease", () =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null))
              )
            ),
            Match.when("sh.mschf.ratking.mailbox.send", () =>
              Effect.gen(function* send() {
                if (!Predicate.isTagged(request.body, "Uint8Array")) {
                  return yield* Effect.die("No request body");
                }

                const { envelope } = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ envelope: Defs.EncryptedEnvelope })
                  )
                )(new TextDecoder().decode(request.body.body));

                const accept = json(request, {
                  receipt: {
                    message: {
                      messageId: envelope.aad.messageId,
                      senderDid: envelope.aad.senderDid,
                    },
                    recipientDid: envelope.aad.recipientDid,
                    seq: sends.length + forwards.length + copies.length + 2,
                    state: "accepted",
                  },
                });

                if (envelope.aad.recipientDid !== people.ea.did) {
                  sends.push(envelope);

                  return accept;
                }

                const opened = yield* openAs(people.ea, envelope);

                const copy = Schema.decodeUnknownOption(
                  Schema.fromJsonString(RelayOutbound)
                )(opened.body);

                const forward = Schema.decodeUnknownOption(
                  Schema.fromJsonString(RelayRecord)
                )(opened.body);

                if (Option.isSome(forward)) {
                  forwards.push(forward.value);

                  return accept;
                }

                if (Option.isNone(copy)) {
                  sends.push(envelope);

                  return accept;
                }

                copies.push({
                  encrypted: envelope.suite.aeadId !== 0,
                  record: copy.value,
                });

                return yield* Match.value(copyMode).pipe(
                  Match.when("accept", () => Effect.succeed(accept)),
                  Match.when("reject", () =>
                    Effect.succeed(
                      json(
                        request,
                        { error: "Forbidden", message: "copy refused" },
                        403
                      )
                    )
                  ),
                  Match.when("stall", () => Effect.never),
                  Match.exhaustive
                );
              })
            ),
            Match.orElse(() =>
              Effect.succeed(json(request, { error: "NotFound" }, 404))
            )
          );
        }).pipe(Effect.orDie)
      );

      const journalState = fs.readFileString(`${state}/relay/tester.json`).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(RelayJournal))
        ),
        Effect.map(
          (entries) => entries.find((entry) => entry.record.id === X)?.state
        )
      );

      const desk = {
        alive: () => false,
        env: Option.some("tester"),
        pane: Option.none(),
        pid: 1,
        reads: true,
        session: "desk",
      };

      const layer = Layer.effectDiscard(
        Effect.gen(function* seed() {
          const secrets = yield* SecretStore;
          const directory = yield* Directory;
          yield* secrets.add(
            "rat_king_fleet_agent_tester_identity",
            Redacted.make(JSON.stringify(people.tester))
          );

          for (const [name, value] of Object.entries(documents)) {
            yield* directory.record(name, value);
          }
        })
      ).pipe(
        Layer.orDie,
        Layer.provideMerge(
          harness(state, http, [], {
            relays: [
              {
                copyOutbound: original.copyOutbound,
                fallbackMinutes: 10,
                mode: "front",
                name: "tester",
                to: "ea",
              },
            ],
          }).pipe(Layer.provideMerge(socketPort))
        )
      );

      yield* Effect.gen(function* firstRun() {
        const ratking = yield* RatKing;
        const injected: (Inbound | InboundRecord)[] = [];

        yield* ratking.run(desk, (inbound) =>
          Effect.sync(() => {
            injected.push(inbound);
          })
        );

        yield* until(() => forwards.length === 1);
        yield* Deferred.await(acked).pipe(Effect.timeout("5 seconds"));
        expect(forwards.map((forward) => forward.id)).toEqual([X]);
        expect(injected).toEqual([]);

        const context = yield* Effect.context();

        const command = (
          step: typeof Step.Type,
          index: number
        ): AsyncCommand<Model, object> => ({
          check: () => true,
          run: (model) => {
            const operation = Effect.gen(function* runCommand() {
              copyMode = step.copy;
              const before = sends.length;
              const body = `body-${index}`;
              const summary = `summary-${index}`;

              const replied = step.replyAll
                ? unique(["person", ...original.cc])
                : ["person"];

              const expected: readonly string[] =
                step.action === "reply"
                  ? replied
                  : unique([step.to, ...step.cc]);

              const exit = yield* Match.value(step.action).pipe(
                Match.when("send", () =>
                  ratking
                    .send(step.to, body, {
                      cc: step.cc,
                      encrypt: step.encrypt,
                      summary,
                    })
                    .pipe(
                      Effect.asVoid,
                      Effect.timeout("3 seconds"),
                      Effect.exit
                    )
                ),
                Match.when("ask", () =>
                  ratking
                    .ask(step.to, body, "500 millis", {
                      cc: step.cc,
                      encrypt: step.encrypt,
                      summary,
                      wait: true,
                    })
                    .pipe(
                      Effect.andThen(
                        Effect.die(
                          "Model has no reply producer: waiting ask must end in NoReply"
                        )
                      ),
                      Effect.catchTag("AskFailed", (error) =>
                        error.code === "NoReply"
                          ? Effect.void
                          : Effect.fail(error)
                      ),
                      Effect.timeout("3 seconds"),
                      Effect.exit
                    )
                ),
                Match.when("reply", () =>
                  ratking
                    .reply(X, body, {
                      encrypt: step.encrypt,
                      replyAll: step.replyAll,
                      summary,
                    })
                    .pipe(
                      Effect.asVoid,
                      Effect.timeout("3 seconds"),
                      Effect.exit
                    )
                ),
                Match.exhaustive
              );

              expect(Exit.isSuccess(exit)).toBe(true);

              const message = sends.slice(before);
              expect(
                message.map((each) => nameOf.get(each.aad.recipientDid))
              ).toEqual(expected);

              if (step.action === "reply" && message[0] !== undefined) {
                const answer = yield* openAs(people.person, message[0]);
                expect(answer.replyTo?.messageId).toBe(X);
              }

              const copied =
                original.copyOutbound &&
                !expected.includes("ea" satisfies NameValue);

              if (copied) {
                model.copies += 1;
                yield* until(() => copies.length >= model.copies);

                const latest = copies.at(-1);
                expect(latest?.encrypted).toBe(step.encrypt);
                expect(latest?.record).toEqual({
                  $type: "sh.mschf.ratking.relay#outbound",
                  body,
                  cc: expected.slice(1),
                  encrypted: step.encrypt,
                  id: message[0]?.aad.messageId,
                  kind: step.action === "send" ? "message" : step.action,
                  replyTo: step.action === "reply" ? X : null,
                  summary,
                  thread:
                    step.action === "reply" ? X : message[0]?.aad.messageId,
                  to: expected[0],
                });
              }

              expect(copies).toHaveLength(model.copies);

              if (expected.includes("person" satisfies NameValue)) {
                model.open = false;
              }

              expect(yield* journalState).toBe(
                model.open ? "pending" : "handled"
              );
            });

            // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the test context.
            return Effect.runPromiseWith(context)(operation);
          },
          toString: () => JSON.stringify(step),
        });

        yield* Effect.promise(() =>
          asyncModelRun(
            () => ({ model: { copies: 0, open: true }, real: {} }),
            [
              command(
                {
                  action: "send",
                  cc: ["carol"],
                  copy: "stall",
                  encrypt: false,
                  replyAll: true,
                  to: "dave",
                },
                -2
              ),
              ...steps.map(command),
              command(
                {
                  action: "reply",
                  cc: [],
                  copy: "reject",
                  encrypt: true,
                  replyAll: true,
                  to: "person",
                },
                -1
              ),
            ]
          )
        );

        yield* Effect.sleep("20 millis");
        expect(forwards).toHaveLength(1);
        expect(injected).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer));

      acquired = false;
      restarted = true;

      yield* Effect.gen(function* restartedRun() {
        const ratking = yield* RatKing;
        const injected: (Inbound | InboundRecord)[] = [];

        yield* ratking.run(desk, (inbound) =>
          Effect.sync(() => {
            injected.push(inbound);
          })
        );

        yield* until(() => acquired);
        yield* until(() => acknowledgments === 2);
        expect(forwards).toHaveLength(1);

        const before = sends.length;

        yield* ratking.reply(X, "after restart", { replyAll: false });

        expect(
          sends.slice(before).map((each) => nameOf.get(each.aad.recipientDid))
        ).toEqual(["person"]);
        expect(yield* journalState).toBe("handled");
        expect(injected).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 30 }, timeout: 120_000 }
);
