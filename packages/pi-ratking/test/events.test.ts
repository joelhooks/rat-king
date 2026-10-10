// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
/* oxlint-disable promise/prefer-await-to-callbacks -- Pi's event bus and Effect HttpClient test adapters take callbacks. */
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  ConfigProvider,
  Clock,
  DateTime,
  Match,
  Redacted,
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

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Directory } from "../src/directory.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import {
  collectFacts,
  injects,
  ratkingExtension,
  RETIRE_EVENT,
  RETIRE_RESULT_EVENT,
  MESSAGE_EVENT,
  RECORD_EVENT,
  STATUS_EVENT,
  STATUS_RESULT_EVENT,
  SEND_EVENT,
  SEND_RESULT_EVENT,
} from "../src/extension.ts";
import { LexiconRecord } from "../src/payload.ts";
import { SecretStore } from "../src/secrets.ts";
import { harness } from "./harness.ts";

const PEER = "did:web:peer.agents.example.invalid";

const Submitted = Schema.fromJsonString(
  Schema.Struct({
    envelope: Schema.Struct({
      aad: Schema.Struct({
        messageId: Schema.String,
        recipientDid: Schema.String,
        senderDid: Schema.String,
      }),
    }),
  })
);

const Result = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    requestId: Schema.String,
    seq: Schema.Number,
    status: Schema.Literal("delivered"),
    to: Schema.String,
  }),
  Schema.Struct({
    code: Schema.String,
    reason: Schema.String,
    requestId: Schema.String,
    status: Schema.Literal("not-delivered"),
  }),
]);

const idle = async () => {};

const fakePi = () => {
  let started: (start: SessionStart) => Promise<void> = idle;

  let ended: () => Promise<void> = idle;

  const pi: PiHost = {
    events: createEventBus(),
    onSessionEnd: (handler) => {
      ended = handler;
    },
    onSessionStart: (handler) => {
      started = handler;
    },
    registerMessageRenderer: () => {},
    registerTool: () => {},
    sendMessage: () => {},
  };

  const start = Effect.promise(async () => {
    await started({ session: "test-session", warn: () => {} });
  });

  const end = Effect.promise(async () => {
    await ended();
  });

  return { end, pi, start };
};

const Case = Schema.Struct({
  body: Schema.String,
  known: Schema.Boolean,
  requestId: Schema.String,
});

it.live.prop(
  "ratking/send answers on ratking/send:result with its requestId: delivered with the mailbox id to a known name, NOT DELIVERED otherwise",
  [Arbitrary.schema(Case)],
  ([sample]) =>
    Effect.gen(function* eventRoundTrip() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const submitted: (typeof Submitted.Type)[] = [];

      const http = HttpClient.make((request) =>
        Effect.gen(function* fakeMailbox() {
          const isSend = request.url.endsWith("sh.mschf.ratking.mailbox.send");

          if (!(isSend && Predicate.isTagged(request.body, "Uint8Array"))) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "MailboxUnavailable" }, { status: 503 })
            );
          }

          const input = yield* Schema.decodeUnknownEffect(Submitted)(
            new TextDecoder().decode(request.body.body)
          ).pipe(Effect.orDie);

          submitted.push(input);

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              receipt: {
                message: {
                  messageId: input.envelope.aad.messageId,
                  senderDid: input.envelope.aad.senderDid,
                },
                recipientDid: input.envelope.aad.recipientDid,
                seq: submitted.length,
                state: "accepted",
              },
            })
          );
        })
      );

      const peer = yield* identity(PEER);
      const peerDocument = yield* document(peer);

      const layer = Layer.effectDiscard(
        Directory.use((directory) =>
          directory.record("peer", peerDocument).pipe(Effect.orDie)
        )
      ).pipe(Layer.provideMerge(harness(state, http)));

      const { end, pi, start } = fakePi();

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => false,
              env: Option.some("tester"),
              pane: Option.none(),
              pid: 1,
              session,
            }),
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);
      });

      yield* start;

      const answered = yield* Deferred.make<
        typeof Result.Type,
        Schema.SchemaError
      >();

      pi.events.on(SEND_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Schema.decodeUnknownEffect(Result)(data));
      });

      pi.events.emit(SEND_EVENT, {
        body: sample.body,
        requestId: sample.requestId,
        to: sample.known ? "peer" : "nobody",
      });

      const result = yield* Deferred.await(answered);

      yield* end;

      expect(result.requestId).toBe(sample.requestId);

      if (sample.known) {
        expect(result).toMatchObject({ status: "delivered", to: "peer" });
        expect(submitted.map((each) => each.envelope.aad.recipientDid)).toEqual(
          [PEER]
        );
        expect(result.status === "delivered" && result.id).toBe(
          submitted[0]?.envelope.aad.messageId
        );
      } else {
        expect(result).toMatchObject({
          code: "UnknownName",
          status: "not-delivered",
        });
        expect(submitted).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);

const Malformed = Schema.Struct({
  kind: Schema.Literals(["muster", "fyi"]),
  requestId: Schema.String,
});

it.live.prop(
  "a ratking/send that fails decode but carries a requestId is answered at once as NOT DELIVERED, and nothing is sent",
  [Arbitrary.schema(Malformed)],
  ([sample]) =>
    Effect.gen(function* malformedSend() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      let calls = 0;

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls += request.url.endsWith("sh.mschf.ratking.mailbox.send")
            ? 1
            : 0;

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "MailboxUnavailable" }, { status: 503 })
          );
        })
      );

      const { end, pi, start } = fakePi();

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => false,
              env: Option.some("tester"),
              pane: Option.none(),
              pid: 1,
              session,
            }),
          layer: harness(state, http),
          tool: Effect.succeed("ratking"),
        })(pi);
      });

      yield* start;

      const answered = yield* Deferred.make<
        typeof Result.Type,
        Schema.SchemaError
      >();

      pi.events.on(SEND_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Schema.decodeUnknownEffect(Result)(data));
      });

      pi.events.emit(SEND_EVENT, {
        body: "hello",
        kind: sample.kind,
        requestId: sample.requestId,
        to: "peer",
      });

      const result = yield* Deferred.await(answered).pipe(
        Effect.timeout("2 seconds")
      );

      yield* end;

      expect(result).toMatchObject({
        code: "NotAttempted",
        requestId: sample.requestId,
        status: "not-delivered",
      });
      expect(result.status === "not-delivered" && result.reason).toContain(
        "InvalidRequest"
      );
      expect(calls).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);

it.effect.prop(
  "only unsettled non-data messages reach the model; data and settled messages stay on the event bus",
  [
    Arbitrary.schema(Schema.Literals(["message", "ask", "reply", "data"])),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([kind, settled]) =>
    Effect.sync(() => {
      expect(injects({ kind }, settled)).toBe(!settled && kind !== "data");
    })
);

it.live.prop(
  "ratking/retire stops the reader and answers with its requestId; later sends are refused as retired and reach no mailbox",
  [Arbitrary.schema(Schema.String)],
  ([requestId]) =>
    Effect.gen(function* retire() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      let sends = 0;

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          sends += request.url.endsWith("sh.mschf.ratking.mailbox.send")
            ? 1
            : 0;

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "MailboxUnavailable" }, { status: 503 })
          );
        })
      );

      const { end, pi, start } = fakePi();

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => false,
              env: Option.some("tester"),
              pane: Option.none(),
              pid: 1,
              session,
            }),
          layer: harness(state, http),
          tool: Effect.succeed("ratking"),
        })(pi);
      });

      yield* start;

      const retired = yield* Deferred.make<unknown>();

      const answered = yield* Deferred.make<
        typeof Result.Type,
        Schema.SchemaError
      >();

      pi.events.on(RETIRE_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(retired, Effect.succeed(data));
      });
      pi.events.on(SEND_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Schema.decodeUnknownEffect(Result)(data));
      });

      pi.events.emit(RETIRE_EVENT, { requestId });

      expect(
        yield* Deferred.await(retired).pipe(Effect.timeout("5 seconds"))
      ).toEqual({ requestId, status: "retired" });

      pi.events.emit(SEND_EVENT, {
        body: "hello",
        requestId: "after",
        to: "peer",
      });

      const result = yield* Deferred.await(answered).pipe(
        Effect.timeout("5 seconds")
      );

      yield* end;

      expect(result).toMatchObject({
        requestId: "after",
        status: "not-delivered",
      });
      expect(result.status === "not-delivered" && result.reason).toContain(
        "retired"
      );
      expect(sends).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 60_000 }
);

it.effect(
  "a non-interactive Pi ignores the inherited RATKING_NAME and pane, and reads only with RATKING_PRINT_NAME",
  () =>
    Effect.gen(function* printFacts() {
      const inherited = {
        HERDR_PANE_ID: "wCD:p3S",
        RATKING_NAME: "rats-nest/rats-nest-desk",
      };

      const print = yield* collectFacts("s1", undefined, false).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(inherited))
        )
      );

      expect(print.env).toEqual(Option.none());
      expect(print.pane).toEqual(Option.none());
      expect(print.reads).toBe(false);

      const optedIn = yield* collectFacts("s1", undefined, false).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ...inherited,
              RATKING_PRINT_NAME: "script-probe",
            })
          )
        )
      );

      expect(optedIn.env).toEqual(Option.some("script-probe"));
      expect(optedIn.reads).toBe(true);

      const interactive = yield* collectFacts("s1", undefined, true).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ RATKING_NAME: inherited.RATKING_NAME })
          )
        )
      );

      expect(interactive.env).toEqual(Option.some(inherited.RATKING_NAME));
      expect(interactive.reads).toBe(true);
    })
);

interface RecordLifecycle {
  start: (start: SessionStart) => Promise<void>;
  end: () => Promise<void>;
}

const RECORD_PEER = "did:web:handset.example.invalid";

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

const host = () => {
  const lifecycle: RecordLifecycle = {
    end: idle,
    start: idle,
  };

  const messages: unknown[] = [];

  const pi: PiHost = {
    events: createEventBus(),
    onSessionEnd: (handler) => {
      lifecycle.end = handler;
    },
    onSessionStart: (handler) => {
      lifecycle.start = handler;
    },
    registerMessageRenderer: () => {},
    registerTool: () => {},
    sendMessage: (message) => {
      messages.push(message);
    },
  };

  return { lifecycle, messages, pi };
};

const facts = (session: string) =>
  Effect.succeed({
    alive: () => false,
    env: Option.some("tester"),
    pane: Option.none<string>(),
    pid: 1,
    reads: false,
    session,
  });

it.live.prop(
  "inbound records stay on ratking/record, messages keep their path, and both checkpoint before ack",
  [
    Arbitrary.schema(Schema.Literals(["record", "message", "raw"])),
    Arbitrary.schema(Schema.String),
  ],
  ([mode, body]) =>
    Effect.gen(function* inbound() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const own = yield* identity("did:web:tester.agents.example.invalid");
      const peer = yield* identity(RECORD_PEER);
      const ownDocument = yield* document(own);
      const peerDocument = yield* document(peer);

      const value = Match.value(mode).pipe(
        Match.when("record", () => ({ $type: "sh.example.desk.answer", body })),
        Match.when("message", () => ({
          $type: "sh.example.extra",
          body,
          from: "handset",
          kind: "message",
        })),
        Match.when("raw", () => ({ $type: 17, body })),
        Match.exhaustive
      );

      const record = JSON.stringify(value);

      const emptyHttp = HttpClient.make((request) =>
        Effect.die(`Unexpected seal request ${request.url}`)
      );

      const envelope = yield* Effect.gen(function* sealInbound() {
        const client = yield* prepare({
          endpoint: "https://mailbox.example.invalid",
          own: yield* ownIdentity(peer),
          peers: [ownDocument],
          serviceDid: "did:web:mailbox.example.invalid",
        });

        return yield* client.seal(own.did, record, {
          replyTo: yield* Schema.decodeUnknownEffect(
            Schema.toType(Defs.MessageRef)
          )({ messageId: "3m7x2ka4xv22a", senderDid: own.did }),
        });
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, emptyHttp)
      );

      const receipt = {
        message: { messageId: envelope.aad.messageId, senderDid: RECORD_PEER },
        recipientDid: own.did,
        seq: 1,
        state: "accepted",
      };

      const acked = yield* Deferred.make<boolean>();

      const leaseUntil = DateTime.formatIso(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300_000)
      );

      let acquired = false;

      const http = HttpClient.make((request) =>
        Effect.gen(function* mailbox() {
          const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

          const response = yield* Match.value(nsid).pipe(
            Match.when("sh.mschf.ratking.mailbox.list", () =>
              Effect.succeed({
                events: acquired
                  ? [
                      {
                        $type: "sh.mschf.ratking.defs#messageEvent",
                        envelope,
                        receipt,
                        seq: 1,
                      },
                    ]
                  : [],
                throughSeq: acquired ? 1 : 0,
              })
            ),
            Match.when("sh.mschf.ratking.runtime.acquireLease", () =>
              Effect.sync(() => {
                acquired = true;

                return {
                  lease: {
                    did: own.did,
                    expiresAt: leaseUntil,
                    generation: 1,
                    harness: {
                      $type: "sh.mschf.ratking.runtime.lease#pi",
                      sessionId: "inbound",
                    },
                    leaseId: "3mxcx45mn7sex",
                  },
                };
              })
            ),
            Match.when("sh.mschf.ratking.mailbox.deliver", () =>
              Effect.succeed({ receipt: { ...receipt, state: "delivered" } })
            ),
            Match.when("sh.mschf.ratking.mailbox.ack", () =>
              Effect.gen(function* ack() {
                expect(
                  JSON.parse(
                    yield* fs.readFileString(`${state}/cursors/tester.json`)
                  )
                ).toEqual({ afterSeq: 1 });
                yield* Deferred.succeed(acked, true);

                return { receipt: { ...receipt, state: "acked" } };
              })
            ),
            Match.when("sh.mschf.ratking.runtime.releaseLease", () =>
              Effect.succeed({})
            ),
            Match.orElse(() => Effect.die(`Unexpected mailbox request ${nsid}`))
          );

          if (nsid === "sh.mschf.ratking.mailbox.list") {
            const output = yield* Schema.decodeUnknownEffect(
              Schema.toType(List.Output)
            )(response);

            const json = yield* Schema.encodeEffect(
              Schema.fromJsonString(List.Output)
            )(output);

            return HttpClientResponse.fromWeb(
              request,
              new Response(json, {
                headers: { "content-type": "application/json" },
              })
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            nsid === "sh.mschf.ratking.runtime.releaseLease"
              ? new Response(null)
              : Response.json(response)
          );
        }).pipe(Effect.orDie)
      );

      const layer = Layer.effectDiscard(
        Effect.gen(function* seed() {
          const secrets = yield* SecretStore;
          const directory = yield* Directory;
          yield* secrets.add(
            "rat_king_fleet_agent_tester_identity",
            Redacted.make(JSON.stringify(own))
          );
          yield* directory.record("tester", ownDocument);
          yield* directory.record("handset", peerDocument);
        })
      ).pipe(
        Layer.orDie,
        Layer.provideMerge(
          harness(state, http).pipe(Layer.provideMerge(socketPort))
        )
      );

      const { lifecycle, messages, pi } = host();
      const records: unknown[] = [];
      const received: unknown[] = [];
      pi.events.on(RECORD_EVENT, (data) => {
        records.push(data);
      });
      pi.events.on(MESSAGE_EVENT, (data) => {
        received.push(data);
      });
      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.map(facts(session), (sessionFacts) => ({
              ...sessionFacts,
              reads: true,
            })),
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);
      });
      yield* Effect.promise(async () => {
        await lifecycle.start({ session: "inbound", warn: () => {} });
      });
      yield* Deferred.await(acked).pipe(Effect.timeout("5 seconds"));
      yield* Effect.promise(async () => {
        await lifecycle.end();
      });

      if (mode === "record") {
        expect(records).toEqual([
          {
            did: RECORD_PEER,
            from: "handset",
            id: envelope.aad.messageId,
            record: value,
            replyTo: "3m7x2ka4xv22a",
            verified: true,
          },
        ]);
        expect(received).toEqual([]);
        expect(messages).toEqual([]);
      } else {
        expect(records).toEqual([]);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          body: mode === "message" ? body : record,
          kind: "message",
          verified: true,
        });
        expect(messages).toHaveLength(1);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 }, timeout: 60_000 }
);

const RecordCase = Schema.StructWithRest(
  Schema.Struct({ $type: Schema.Literal("sh.example.desk.question") }),
  [Schema.Record(Schema.String, Schema.Json)]
);

it.live.prop(
  "event records seal as-is, default to encrypted, and reach a reserved recipient without a secret or configured document",
  [
    Arbitrary.schema(RecordCase),
    Arbitrary.schema(Schema.UndefinedOr(Schema.Boolean)),
  ],
  ([sample, encrypt]) =>
    Effect.gen(function* roundTrip() {
      const record = yield* Schema.decodeEffect(
        Schema.fromJsonString(RecordCase)
      )(yield* Schema.encodeEffect(Schema.fromJsonString(RecordCase))(sample));

      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const peer = yield* identity(RECORD_PEER);
      const peerDocument = yield* document(peer);

      const submitted = yield* Deferred.make<
        typeof Send.Input.Type,
        Schema.SchemaError
      >();

      const lookups: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.gen(function* mailbox() {
          if (
            request.url.includes("sh.mschf.ratking.mailbox.getPeerDocument")
          ) {
            lookups.push(new URL(request.url).searchParams.get("did") ?? "");

            return HttpClientResponse.fromWeb(
              request,
              Response.json({ document: peerDocument })
            );
          }

          if (!Predicate.isTagged(request.body, "Uint8Array")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "MailboxUnavailable" }, { status: 503 })
            );
          }

          const input = yield* Schema.decodeEffect(
            Schema.fromJsonString(Send.Input)
          )(new TextDecoder().decode(request.body.body));

          yield* Deferred.succeed(submitted, input);

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              receipt: {
                message: {
                  messageId: input.envelope.aad.messageId,
                  senderDid: input.envelope.aad.senderDid,
                },
                recipientDid: RECORD_PEER,
                seq: 1,
                state: "accepted",
              },
            })
          );
        }).pipe(Effect.orDie)
      );

      const { lifecycle, pi } = host();

      const layer = harness(state, http, [], {
        reserved: { handset: { aliases: ["pocket"], did: RECORD_PEER } },
      });

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts,
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);
      });
      yield* Effect.promise(async () => {
        await lifecycle.start({ session: "record-send", warn: () => {} });
      });
      const result = yield* Deferred.make<unknown>();
      pi.events.on(SEND_RESULT_EVENT, (value) => {
        Deferred.doneUnsafe(result, Effect.succeed(value));
      });
      const request = { record, requestId: "record", to: "pocket" };

      if (encrypt !== undefined) {
        Object.assign(request, { encrypt });
      }

      pi.events.emit(SEND_EVENT, request);

      const input = yield* Deferred.await(submitted).pipe(
        Effect.timeout("5 seconds")
      );

      expect(yield* Deferred.await(result)).toMatchObject({
        requestId: "record",
        status: "delivered",
        to: "handset",
      });
      expect(lookups).toEqual([RECORD_PEER]);
      expect(input.envelope.suite.aeadId).toBe(encrypt === false ? 0 : 1);

      const sender = yield* Directory.use((directory) =>
        directory.resolve("tester")
      ).pipe(Effect.provide(layer));

      const opened = yield* Effect.gen(function* decrypt() {
        const client = yield* prepare({
          endpoint: "https://mailbox.example.invalid",
          own: yield* ownIdentity(peer),
          peers: [sender.document],
          serviceDid: "did:web:mailbox.example.invalid",
        });

        return yield* client.open(input.envelope);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, http)
      );

      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(LexiconRecord))(
          opened.body
        )
      ).toEqual(record);
      yield* Effect.promise(async () => {
        await lifecycle.end();
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 }, timeout: 60_000 }
);

it.live.prop(
  "body and record are mutually exclusive and a missing payload is refused without a send",
  [Arbitrary.schema(Schema.Boolean)],
  ([both]) =>
    Effect.gen(function* exclusive() {
      const { pi } = host();
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();

      const http = HttpClient.make((request) =>
        Effect.die(`Unexpected request ${request.url}`)
      );

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts,
          layer: harness(state, http),
          tool: Effect.succeed("ratking"),
        })(pi);
      });
      const answered = yield* Deferred.make<unknown>();
      pi.events.on(SEND_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Effect.succeed(data));
      });
      const request = { requestId: "exclusive" };

      if (both) {
        Object.assign(request, {
          body: "hello",
          record: { $type: "sh.example.desk.question" },
        });
      }

      pi.events.emit(SEND_EVENT, request);
      expect(yield* Deferred.await(answered)).toMatchObject({
        code: "NotAttempted",
        requestId: "exclusive",
        status: "not-delivered",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 } }
);

it.live.prop(
  "status answers with its requestId and the current reader state",
  [Arbitrary.schema(Schema.String)],
  ([requestId]) =>
    Effect.gen(function* status() {
      const { lifecycle, pi } = host();
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();

      const http = HttpClient.make((request) =>
        Effect.die(`Unexpected request ${request.url}`)
      );

      const answered = yield* Deferred.make<unknown>();
      pi.events.on(STATUS_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(answered, Effect.succeed(data));
      });
      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts,
          layer: harness(state, http),
          tool: Effect.succeed("ratking"),
        })(pi);
      });
      yield* Effect.promise(async () => {
        await lifecycle.start({ session: "record-status", warn: () => {} });
      });
      const started = yield* Deferred.make<unknown>();
      pi.events.on(SEND_RESULT_EVENT, (data) => {
        Deferred.doneUnsafe(started, Effect.succeed(data));
      });
      pi.events.emit(SEND_EVENT, {
        body: "not sent",
        requestId: "self",
        to: "tester",
      });
      yield* Deferred.await(started);
      pi.events.emit(STATUS_EVENT, { requestId });
      expect(yield* Deferred.await(answered)).toEqual({
        did: "did:web:tester.agents.example.invalid",
        name: "tester",
        reader: "send-only",
        requestId,
      });
      yield* Effect.promise(async () => {
        await lifecycle.end();
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 60_000 }
);
