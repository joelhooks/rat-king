// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { shownIds } from "../src/pending.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

type Arbiter = "accept" | "decline";

interface Mailbox {
  readonly acks: Map<string, number>;
  readonly unacked: Set<string>;
}

interface SentMessage {
  readonly customType: string;
  readonly details?: unknown;
}

const nothing = () => {};

const idleHandler = async () => {
  await Promise.resolve();
};

const ignoreShown = (_id: string) => {};

const ignoreDelivery: Deliver = () => Effect.void;

const mailbox = (): Mailbox => ({ acks: new Map(), unacked: new Set() });

const wakeRecord = (id: string, status: "cancelled" | "matched") => ({
  $type: "sh.mschf.agentgraph.wake",
  finishedAt: "2026-01-01T00:01:00Z",
  kind: "ping",
  label: `Watch ${id}`,
  source: "herdr_ping_wait",
  startedAt: "2026-01-01T00:00:00Z",
  status,
  text: `Wake ${id}`,
  watch: id,
});

const message = (id: string, digestMinutes?: number): Inbound => {
  const inbound: Inbound = {
    body: "mail",
    cc: false,
    copy: digestMinutes !== undefined,
    did: "did:web:sender.invalid",
    from: "sender",
    id,
    kind: "message",
    label: Option.none(),
    replyTo: Option.none(),
    summary: Option.none(),
    verified: true,
  };

  if (digestMinutes !== undefined) {
    Object.assign(inbound, { digestMinutes });
  }

  return inbound;
};

const Offer = Schema.Struct({
  accept: Schema.declare((input): input is () => void =>
    Predicate.isFunction(input)
  ),
  customType: Schema.String,
  details: Schema.Unknown,
  id: Schema.String,
});

const reader = (box: Mailbox, arbiter: Arbiter) =>
  Effect.gen(function* startReader() {
    let start: (facts: SessionStart) => Promise<void> = idleHandler;
    let stop: () => Promise<void> = idleHandler;
    let idle: (messages: readonly unknown[]) => Promise<void> = idleHandler;
    let before = nothing;
    let shown = ignoreShown;
    let deliver = ignoreDelivery;
    let replay: readonly string[] = [];
    const sent: SentMessage[] = [];
    const offered: string[] = [];
    const queued: SentMessage[] = [];
    const fs = yield* FileSystem.FileSystem;
    const clock = yield* Clock.Clock;

    const layer = Layer.merge(
      harness(
        yield* fs.makeTempDirectoryScoped(),
        HttpClient.make(() => Effect.die("Unexpected HTTP"))
      ),
      Layer.mock(RatKing, {
        run: (_facts, handler) =>
          Effect.sync(() => {
            deliver = handler;
            replay = [...box.unacked];
          }),
      })
    );

    const pi: PiHost = {
      events: {
        emit: (event, request) => {
          if (event === "pi-until:follow-up") {
            const offer = Schema.decodeUnknownSync(Offer)(request);
            offered.push(offer.id);

            if (arbiter === "accept") {
              offer.accept();
              queued.push({
                customType: offer.customType,
                details: { followUpId: "follow-up", receipt: offer.details },
              });
            }
          }
        },
        on: () => nothing,
      },
      onAgentEnd: (handler) => {
        idle = handler;
      },
      onBeforeAgentStart: (handler) => {
        before = handler;
      },
      onMessageShown: (handler) => {
        shown = handler;
      },
      onSessionEnd: (handler) => {
        stop = handler;
      },
      onSessionStart: (handler) => {
        start = handler;
      },
      registerMessageRenderer: nothing,
      registerTool: nothing,
      sendMessage: (sentMessage) => {
        sent.push(sentMessage);
      },
    };

    yield* Effect.promise(async () => {
      await ratkingExtension({
        facts: (session) =>
          Effect.succeed({
            alive: () => true,
            env: Option.none(),
            pane: Option.none(),
            pid: 1,
            session,
          }),
        layer: Layer.merge(layer, Layer.succeed(Clock.Clock, clock)),
        tool: Effect.succeed("ratking"),
      })(pi);
      await startSession(start, { session: "ack-paths", warn: nothing });
    });
    yield* Effect.addFinalizer(() => Effect.promise(stop));

    const post = (id: string, inbound: Parameters<Deliver>[0]) => {
      box.unacked.add(id);

      return deliver(
        inbound,
        false,
        Effect.sync(() => {
          box.unacked.delete(id);
          box.acks.set(id, (box.acks.get(id) ?? 0) + 1);
        })
      );
    };

    const postWake = (id: string, status: "cancelled" | "matched") =>
      post(id, {
        did: "did:key:invented",
        from: "worker",
        id,
        record: wakeRecord(id, status),
        replyTo: Option.none(),
        verified: true,
      });

    const display = () => {
      for (const sentMessage of [...sent.splice(0), ...queued.splice(0)]) {
        for (const id of shownIds({ ...sentMessage, role: "custom" })) {
          shown(id);
        }
      }
    };

    return {
      before: () => {
        before();
      },
      display,
      idle: () =>
        Effect.promise(async () => {
          await idle([]);
        }),
      offered,
      post,
      postWake,
      replay: () => replay,
      sent,
      settle: Effect.yieldNow,
    };
  });

const Scenario = Schema.Literals([
  "direct",
  "arbiterAccepted",
  "arbiterDeclined",
  "digest",
  "dispatchFlush",
  "withdraw",
]);

const acksOf = (box: Mailbox, ids: readonly string[]) =>
  ids.map((id) => box.acks.get(id) ?? 0);

const ones = (count: number) => Array.from({ length: count }, () => 1);

const zeros = (count: number) => Array.from({ length: count }, () => 0);

it.effect.prop(
  "every displayed or withdrawn id is acked exactly once, and none is acked before display",
  [Arbitrary.schema(Scenario)],
  ([scenario]) =>
    Effect.gen(function* custody() {
      const box = mailbox();
      const arbiter = scenario === "arbiterAccepted" ? "accept" : "decline";
      const r = yield* reader(box, arbiter);
      const ids = ["a", "b"];

      if (scenario === "direct") {
        yield* r.post("a", message("a"));
        expect(acksOf(box, ["a"])).toEqual([0]);
        r.display();
        yield* r.settle;
        expect(acksOf(box, ["a"])).toEqual([1]);
        r.display();
        expect(acksOf(box, ["a"])).toEqual([1]);

        return;
      }

      if (scenario === "digest") {
        yield* r.post("a", message("a", 1));
        yield* r.post("b", message("b", 1));
        expect(acksOf(box, ids)).toEqual(zeros(2));
        yield* TestClock.adjust(120_000);
        expect(acksOf(box, ids)).toEqual(zeros(2));
        r.display();
        yield* r.settle;
        expect(acksOf(box, ids)).toEqual(ones(2));

        return;
      }

      if (scenario === "dispatchFlush") {
        yield* r.post("a", {
          ...message("a"),
          cc: true,
        });
        yield* r.post("b", message("b"));
        expect(acksOf(box, ids)).toEqual(zeros(2));
        r.before();
        r.display();
        yield* r.settle;
        expect(acksOf(box, ids)).toEqual(ones(2));

        return;
      }

      if (scenario === "withdraw") {
        r.before();
        yield* r.postWake("a", "matched");
        yield* r.postWake("a", "cancelled");
        yield* r.idle();
        expect(r.offered).toEqual([]);
        expect(r.sent).toEqual([]);
        yield* r.settle;
        expect(acksOf(box, ["a"])).toEqual([1]);
        expect([...box.unacked]).toEqual([]);

        return;
      }

      r.before();
      yield* r.postWake("a", "matched");
      yield* r.postWake("b", "matched");
      expect(acksOf(box, ids)).toEqual(zeros(2));
      yield* r.idle();

      if (scenario === "arbiterAccepted") {
        expect(r.offered).toHaveLength(1);
        expect(r.sent).toEqual([]);
        yield* r.settle;
        expect(acksOf(box, ids)).toEqual(zeros(2));
        r.display();
        yield* r.settle;
        expect(acksOf(box, ids)).toEqual(ones(2));
        r.display();
        yield* r.settle;
        expect(acksOf(box, ids)).toEqual(ones(2));

        return;
      }

      expect(r.offered).toHaveLength(1);
      expect(r.sent).toHaveLength(1);
      yield* r.settle;
      expect(acksOf(box, ids)).toEqual(zeros(2));
      r.display();
      yield* r.settle;
      expect(acksOf(box, ids)).toEqual(ones(2));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "a wake shown through the arbiter is not redelivered to a fresh reader",
  () =>
    Effect.gen(function* restart() {
      const box = mailbox();
      const first = yield* reader(box, "accept");
      first.before();
      yield* first.postWake("a", "matched");
      yield* first.idle();
      expect(first.offered).toHaveLength(1);
      first.display();
      yield* first.settle;

      const second = yield* reader(box, "accept");

      expect(second.replay()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "a wake the arbiter accepted but never showed is redelivered to a fresh reader",
  () =>
    Effect.gen(function* quit() {
      const box = mailbox();
      const first = yield* reader(box, "accept");
      first.before();
      yield* first.postWake("a", "matched");
      yield* first.idle();
      yield* first.settle;
      expect(first.offered).toHaveLength(1);

      const second = yield* reader(box, "accept");

      expect(second.replay()).toEqual(["a"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
