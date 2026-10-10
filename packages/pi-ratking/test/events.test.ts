// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
/* oxlint-disable promise/prefer-await-to-callbacks -- Pi's event bus and Effect HttpClient test adapters take callbacks. */
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
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

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Directory } from "../src/directory.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import {
  injects,
  ratkingExtension,
  RETIRE_EVENT,
  RETIRE_RESULT_EVENT,
  SEND_EVENT,
  SEND_RESULT_EVENT,
} from "../src/extension.ts";
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
