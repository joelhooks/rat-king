import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { Directory } from "@rat-king/ratking-client/directory";
import { secretName } from "@rat-king/ratking-client/name";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import { ReaderState } from "@rat-king/ratking-client/ratking";
import { PivotReceipt } from "@rat-king/ratking-client/reader-journal";
import {
  Arbitrary,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schedule,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { chooseName } from "../src/name.ts";
import { harness } from "./harness.ts";
import {
  runModel,
  startReader,
  successorMailbox,
} from "./successor-fixture.ts";

const askBody = (body: string) =>
  JSON.stringify({
    body,
    from: "peer",
    kind: "ask",
    reply: { parent: "previous", root: "root" },
    to: "tester",
  });

const Step = Schema.Literals(["pending", "answer", "restart"]);

const Case = Schema.Struct({
  childFirst: Schema.Boolean,
  lapse: Schema.Boolean,
  steps: Schema.Array(Step).check(Schema.isMaxLength(4)),
});

const proveSuccessor = (scenario: typeof Case.Type) =>
  Effect.gen(function* successorProof() {
    const fs = yield* FileSystem.FileSystem;
    const state = yield* fs.makeTempDirectoryScoped();
    const own = yield* identity("did:web:tester.agents.example.invalid");
    const peer = yield* identity("did:web:peer.agents.example.invalid");
    const ownDocument = yield* document(own);
    const peerDocument = yield* document(peer);
    const secrets = new Map([[secretName("tester"), JSON.stringify(own)]]);
    const server = successorMailbox();

    const layer = Layer.effectDiscard(
      Directory.use((directory) =>
        Effect.gen(function* register() {
          yield* directory.record("tester", ownDocument);
          yield* directory.record("peer", peerDocument);
        })
      ).pipe(Effect.orDie)
    ).pipe(
      Layer.provideMerge(harness(state, server.http, [], { secrets })),
      Layer.provideMerge(server.socket)
    );

    const sender = yield* prepare({
      endpoint: "https://mailbox.example.invalid",
      own: yield* ownIdentity(peer),
      peers: [ownDocument],
      serviceDid: "did:web:mailbox.example.invalid",
    }).pipe(Effect.provideService(HttpClient.HttpClient, server.http));

    const add = (body: string) =>
      Effect.gen(function* appendInbound() {
        const envelope = yield* sender.seal(own.did, () => body, {
          encrypt: false,
        });

        const seq = server.events.length + 1;

        const event = yield* Schema.decodeUnknownEffect(
          Schema.toType(Defs.MessageEvent)
        )({
          $type: "sh.mschf.ratking.defs#messageEvent",
          envelope,
          receipt: {
            message: {
              messageId: envelope.aad.messageId,
              senderDid: peer.did,
            },
            recipientDid: own.did,
            seq,
            state: "accepted",
          },
          seq,
        });

        server.events.push(event);

        return envelope.aad.messageId;
      });

    const turn = JSON.stringify({
      $type: "sh.mschf.agentgraph.turn",
      agent: "peer",
      at: "2030-01-01T00:00:00Z",
      session: "peer-session",
      state: "done",
      stopReason: "stop",
      turnId: "peer-session:1",
      version: "0.1",
    });

    const initial = yield* add(askBody("initial"));
    yield* add(turn);

    const facts = {
      alive: () => false,
      env: Option.some("tester"),
      pane: Option.none<string>(),
      pid: 1,
      session: "parent",
    };

    yield* fs.makeDirectory(`${state}/cursors`, { recursive: true });
    yield* fs.writeFileString(
      `${state}/cursors/tester.json`,
      JSON.stringify({ afterSeq: 0 })
    );
    const parent = yield* startReader(layer, facts);
    yield* parent.live.pipe(Effect.timeout("3 seconds"));

    for (let index = 0; index < 2; index += 1) {
      const shown = yield* Queue.take(parent.deliveries).pipe(
        Effect.timeout("3 seconds")
      );

      yield* shown.ack;
    }

    const parentStatus = yield* parent.king.status;

    const childFacts = {
      ...facts,
      pid: 2,
      session: "child",
      succeeds: "parent",
      successor: true,
    };

    let child = scenario.childFirst
      ? yield* startReader(layer, childFacts)
      : undefined;

    if (child !== undefined) {
      yield* child.held.pipe(Effect.timeout("5 seconds"));
      expect(ReaderState.$is("Live")((yield* parent.king.status).reader)).toBe(
        true
      );
      expect(
        ReaderState.$is("SendOnly")((yield* child.king.status).reader)
      ).toBe(true);
    }

    const sent = yield* parent.king.ask("peer", "outgoing", undefined, {
      wait: false,
    });

    const before = yield* parent.king.pending;
    expect(before.map((entry) => entry.id).toSorted()).toEqual(
      [initial, sent.delivered.id].toSorted()
    );

    if (scenario.lapse) {
      server.failRelease();
    }

    yield* parent.stop;
    const handoff = yield* add(askBody("handoff"));
    const [first] = server.events;

    if (first !== undefined) {
      server.events.push({
        ...first,
        receipt: { ...first.receipt, seq: server.events.length + 1 },
        seq: server.events.length + 1,
      });
    }

    yield* add(turn);

    if (scenario.lapse) {
      server.expire();
    }

    child ??= yield* startReader(layer, childFacts);
    yield* child.live;
    const arrived = yield* Queue.take(child.deliveries);
    expect(arrived.inbound.id).toBe(handoff);
    yield* arrived.ack;
    const receiptFile = `${state}/pivots/tester-2.json`;

    const receipt = yield* fs
      .readFileString(receiptFile)
      .pipe(
        Effect.retry(
          Schedule.spaced("1 millis").pipe(
            Schedule.while(({ attempt }) => attempt < 1000)
          )
        ),
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(PivotReceipt))
        )
      );

    expect(receipt.before.inbound).toEqual([initial]);
    expect(receipt.before.outbound).toEqual([sent.delivered.id]);
    expect(receipt.after.inbound.toSorted()).toEqual(
      [initial, handoff].toSorted()
    );
    expect(receipt.after.outbound).toEqual([sent.delivered.id]);
    expect(receipt.counts).toEqual({
      after: { inbound: 2, outbound: 1 },
      before: { inbound: 1, outbound: 1 },
    });
    expect(receipt.source).toBe("local-journals+mailbox-inbound-events");
    expect(receipt.session).not.toBe(receipt.parentSession);
    expect(receipt.generation).toBeGreaterThan(receipt.parentGeneration);
    expect((yield* child.king.status).self).toEqual(parentStatus.self);
    expect(yield* Queue.size(child.deliveries)).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.maximum()).toBe(1);
    expect(
      server.attempts
        .filter(
          (input) =>
            input.harness.$type === "sh.mschf.ratking.runtime.lease#pi" &&
            input.harness.sessionId === "child"
        )
        .every(
          (input) =>
            input.leaseId === undefined && input.generation === undefined
        )
    ).toBe(true);
    expect(secrets.size).toBe(1);
    const lateParent = yield* startReader(layer, facts);
    yield* lateParent.held.pipe(Effect.timeout("5 seconds"));
    expect(ReaderState.$is("Live")((yield* child.king.status).reader)).toBe(
      true
    );
    expect(
      ReaderState.$is("SendOnly")((yield* lateParent.king.status).reader)
    ).toBe(true);
    yield* lateParent.stop;
    expect(server.maximum()).toBe(1);
    expect(
      chooseName({
        entries: [{ name: "tester", session: "parent", source: "env" }],
        env: Option.some("tester"),
        parentSession: "parent",
        session: "fork",
      }).source
    ).toBe("forked");
    let current = child;
    yield* runModel(scenario.steps, { replies: 0 }, (model, step) =>
      Effect.gen(function* command() {
        if (step === "restart") {
          yield* current.stop;

          if (scenario.lapse) {
            server.expire();
          }

          current = yield* startReader(layer, childFacts);
          yield* current.live;
        } else if (step === "answer" && model.replies === 0) {
          yield* current.king.reply(initial, "answer");
          model.replies += 1;
          const reply = server.requests.at(-1);
          expect(reply).toBeDefined();

          if (reply !== undefined) {
            const opened = yield* sender.open(reply);

            const payload = yield* Schema.decodeEffect(PayloadJson)(
              opened.body
            );

            expect(payload.reply).toEqual({ parent: initial, root: "root" });
          }
        }

        const pending = yield* current.king.pending;
        expect(
          pending
            .filter((entry) => entry.outbound !== undefined)
            .map((entry) => entry.id)
        ).toEqual([sent.delivered.id]);
        expect(
          pending
            .filter((entry) => entry.outbound === undefined)
            .map((entry) => entry.id)
            .toSorted()
        ).toEqual(
          (model.replies === 0 ? [initial, handoff] : [handoff]).toSorted()
        );
        expect(server.requests).toHaveLength(1 + model.replies);
        expect(yield* Queue.size(current.deliveries)).toBe(0);
      })
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

for (const childFirst of [false, true]) {
  for (const lapse of [false, true]) {
    it.live.prop(
      `successor ${childFirst ? "starts before" : "starts after"} parent stops; lease ${lapse ? "lapses after failed release" : "releases"}; asks and shown records survive`,
      [Arbitrary.schema(Schema.Array(Step).check(Schema.isMaxLength(4)))],
      ([steps]) =>
        proveSuccessor({
          childFirst,
          lapse,
          steps: ["pending", "answer", "restart", "pending", ...steps],
        }),
      { arbitrary: { runs: 2 }, timeout: 45_000 }
    );
  }
}
