// @effect-diagnostics asyncFunction:off -- fast-check asyncModelRun drives Pi's Promise extension API.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import { Arbitrary, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { shownIds, shownInHistory } from "../src/pending.ts";
import type { HistoryEntry } from "../src/pending.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

type Message = Parameters<PiHost["sendMessage"]>[0];

type Delivery = Parameters<PiHost["sendMessage"]>[1];

interface Mailbox {
  readonly acks: Map<string, number>;
  readonly early: string[];
  readonly posted: string[];
  readonly state: string;
  readonly unacked: Set<string>;
}

interface Session {
  readonly entries: HistoryEntry[];
}

const Kind = Schema.Literals(["direct", "sentBy", "quiet", "cc", "ruled"]);

const nothing = () => {};

const idleHandler = async () => {
  await Promise.resolve();
};

const ignoreShown = (_id: string) => {};

const ignoreDelivery: Deliver = () => Effect.void;

const entryOf = (message: Message): HistoryEntry => ({
  customType: message.customType,
  details: message.details,
  type: "custom_message",
});

const inboundOf = (kind: typeof Kind.Type, id: string): Inbound => {
  const inbound: Inbound = {
    body: "mail",
    cc: kind === "cc",
    did: "did:web:sender.invalid",
    from: "sender",
    id,
    kind: "message",
    label: Option.none(),
    replyTo: Option.none(),
    summary: Option.none(),
    verified: true,
  };

  if (kind === "sentBy") {
    Object.assign(inbound, { sentBy: "muster/launcher" });
  }

  if (kind === "quiet") {
    Object.assign(inbound, { copy: true, quiet: true });
  }

  if (kind === "ruled") {
    Object.assign(inbound, {
      levers: {
        enabled: true,
        prefs: {
          rules: [{ id: "hold", match: { from: "sender" }, route: "quiet" }],
        },
      },
    });
  }

  return inbound;
};

const occurrences = (session: Session, id: string) =>
  session.entries.filter((entry) => shownInHistory([entry]).has(id)).length;

const settle = async () => {
  // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- yields the scheduler so fire-and-forget acks land.
  await Effect.runPromise(Effect.yieldNow.pipe(Effect.repeat({ times: 3 })));
};

const tick = async () => {
  // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- waits out the shortened digest tick in real time.
  await Effect.runPromise(Effect.sleep(80));
  await settle();
};

const rig = (box: Mailbox, session: Session, drop: boolean) => {
  const { state } = box;
  let streaming = false;
  let start: (facts: SessionStart) => Promise<void> = idleHandler;
  let stop: () => Promise<void> = idleHandler;
  let ended: (messages: readonly unknown[]) => Promise<void> = idleHandler;
  let before = nothing;
  let turnEnd = nothing;
  let shown = ignoreShown;
  let deliver = ignoreDelivery;
  let replay: readonly string[] = [];
  let turns = 0;
  const nextTurn: Message[] = [];
  const followUps: Message[] = [];
  const deferred: Message[] = [];

  const layer = Layer.merge(
    harness(
      state,
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

  const loop = (message: Message) => {
    session.entries.push(entryOf(message));

    for (const id of shownIds({ ...message, role: "custom" })) {
      shown(id);
    }
  };

  const pi: PiHost = {
    events: { emit: nothing, on: () => nothing },
    onAgentEnd: (handler) => {
      ended = handler;
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
    onTurnEnd: (handler) => {
      turnEnd = handler;
    },
    registerMessageRenderer: nothing,
    registerTool: nothing,
    sendMessage: (message: Message, delivery: Delivery) => {
      if (drop) {
        return;
      }

      if (delivery?.deliverAs === "nextTurn") {
        nextTurn.push(message);
      } else if (delivery?.triggerTurn === true && streaming) {
        followUps.push(message);
      } else if (delivery?.triggerTurn === true) {
        turns += 1;
        streaming = true;
        loop(message);
      } else if (streaming) {
        deferred.push(message);
      } else {
        session.entries.push(entryOf(message));
      }
    },
    shownInSession: () => shownInHistory(session.entries),
  };

  const ready = async () => {
    await ratkingExtension({
      facts: (id) =>
        Effect.succeed({
          alive: () => true,
          env: Option.none(),
          pane: Option.none(),
          pid: 1,
          session: id,
        }),
      layer,
      tool: Effect.succeed("ratking"),
    })(pi);
    await startSession(start, {
      digestTickMillis: 20,
      isIdle: () => !streaming,
      session: "quiet-ack",
      warn: nothing,
    });
    await settle();
  };

  const post = async (kind: typeof Kind.Type, id: string) => {
    box.unacked.add(id);
    box.posted.push(id);
    // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- Pi's deliver callback is driven from a fast-check command.
    await Effect.runPromise(
      deliver(
        inboundOf(kind, id),
        kind === "sentBy",
        Effect.sync(() => {
          if (occurrences(session, id) === 0) {
            box.early.push(id);
          }

          box.unacked.delete(id);
          box.acks.set(id, (box.acks.get(id) ?? 0) + 1);
        })
      )
    );
    await settle();
  };

  const begin = async () => {
    streaming = true;
    before();

    for (const message of nextTurn.splice(0)) {
      loop(message);
    }

    await settle();
  };

  const finish = async () => {
    streaming = true;

    for (const message of followUps.splice(0)) {
      loop(message);
    }

    for (const message of deferred.splice(0)) {
      session.entries.push(entryOf(message));
    }

    turnEnd();
    streaming = false;
    await ended([]);
    await settle();
  };

  const redeliver = async () => {
    for (const id of replay) {
      // oxlint-disable-next-line no-await-in-loop -- redelivery order is the claim.
      await post("direct", id);
    }
  };

  return {
    begin,
    finish,
    post,
    ready,
    redeliver,
    stop: async () => {
      await stop();
    },
    turns: () => turns,
  };
};

type Rig = ReturnType<typeof rig>;

interface Real {
  box: Mailbox;
  current: Rig;
  session: Session;
}

interface Model {
  ids: number;
}

const Step = Schema.Union([
  Schema.Struct({ kind: Kind, step: Schema.Literal("post") }),
  Schema.Struct({ step: Schema.Literals(["begin", "finish", "restart"]) }),
  Schema.Struct({ step: Schema.Literal("crash") }),
]);

const verify = (real: Real) => {
  for (const id of real.box.posted) {
    expect(occurrences(real.session, id)).toBeLessThanOrEqual(1);
    expect(real.box.acks.get(id) ?? 0).toBeLessThanOrEqual(1);

    expect(real.box.acks.get(id) ?? 0).toBe(occurrences(real.session, id));
  }

  expect(real.box.early).toEqual([]);
};

const command = (step: typeof Step.Type): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    if (step.step === "post") {
      model.ids += 1;
      await real.current.post(step.kind, `m${model.ids}`);
    }

    if (step.step === "begin") {
      await real.current.begin();
    }

    if (step.step === "finish") {
      await real.current.finish();
    }

    if (step.step === "restart" || step.step === "crash") {
      await real.current.stop();
      real.current = rig(real.box, real.session, step.step === "crash");
      await real.current.ready();
      await real.current.redeliver();
    }

    verify(real);
  },
  toString: () => JSON.stringify(step),
});

interface Setup {
  model: Model;
  real: Real;
}

const fresh = async (): Promise<Setup> => {
  // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- the rig is built inside a fast-check async model, outside an Effect test body.
  const state = await Effect.runPromise(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectory()),
      Effect.provide(NodeServices.layer)
    )
  );

  const box: Mailbox = {
    acks: new Map(),
    early: [],
    posted: [],
    state,
    unacked: new Set(),
  };

  const session: Session = { entries: [] };

  return {
    model: { ids: 0 },
    real: { box, current: rig(box, session, false), session },
  };
};

it.effect.prop(
  "a displayed id is rendered once across restarts and acked only once its session entry exists",
  [Arbitrary.array(Arbitrary.schema(Step), { maxLength: 14, minLength: 1 })],
  ([steps]) =>
    Effect.promise(async () => {
      const setup = await fresh();
      await setup.real.current.ready();
      await asyncModelRun(() => setup, steps.map(command));
      await setup.real.current.finish();
      verify(setup.real);
    })
);

it.effect(
  "a quiet send shown by display alone is acked, and a restart does not show it again",
  () =>
    Effect.promise(async () => {
      const setup = await fresh();
      await setup.real.current.ready();
      await setup.real.current.post("sentBy", "q1");
      expect(setup.real.box.acks.get("q1")).toBe(1);
      expect(occurrences(setup.real.session, "q1")).toBe(1);
      await setup.real.current.stop();
      setup.real.current = rig(setup.real.box, setup.real.session, false);
      await setup.real.current.ready();
      expect(setup.real.box.unacked.size).toBe(0);
      setup.real.box.unacked.add("q1");
      await setup.real.current.redeliver();
      expect(occurrences(setup.real.session, "q1")).toBe(1);
    })
);

it.effect(
  "a shown id that Pi redelivers is acked silently without a second display",
  () =>
    Effect.promise(async () => {
      const setup = await fresh();
      await setup.real.current.ready();
      await setup.real.current.post("sentBy", "q1");
      await setup.real.current.stop();
      setup.real.box.unacked.add("q1");
      setup.real.box.acks.clear();
      setup.real.current = rig(setup.real.box, setup.real.session, false);
      await setup.real.current.ready();
      await setup.real.current.redeliver();
      expect(setup.real.box.acks.get("q1")).toBe(1);
      expect(occurrences(setup.real.session, "q1")).toBe(1);
      expect(setup.real.box.unacked.size).toBe(0);
    })
);

it.effect(
  "two copies held for the next turn show as one digest and both are acked",
  () =>
    Effect.promise(async () => {
      const setup = await fresh();
      await setup.real.current.ready();
      await setup.real.current.post("quiet", "a");
      await setup.real.current.post("quiet", "b");
      expect(setup.real.box.unacked.size).toBe(2);
      await setup.real.current.begin();
      await setup.real.current.finish();
      expect(setup.real.box.acks.get("a")).toBe(1);
      expect(setup.real.box.acks.get("b")).toBe(1);
      expect(setup.real.session.entries).toHaveLength(1);
    })
);

it.effect(
  "a crash before the entry is appended leaves the mail unacked and shows it once after restart",
  () =>
    Effect.promise(async () => {
      const setup = await fresh();
      setup.real.current = rig(setup.real.box, setup.real.session, true);
      await setup.real.current.ready();
      await setup.real.current.post("sentBy", "q1");
      expect(setup.real.box.acks.get("q1")).toBeUndefined();
      expect(setup.real.box.unacked.has("q1")).toBe(true);
      await setup.real.current.stop();
      setup.real.current = rig(setup.real.box, setup.real.session, false);
      await setup.real.current.ready();
      await setup.real.current.redeliver();
      expect(occurrences(setup.real.session, "q1")).toBe(1);
      expect(setup.real.box.acks.get("q1")).toBe(1);
    })
);

it.effect(
  "an idle Pi shows and acks mail its own quiet rule held within a tick, without a turn",
  () =>
    Effect.promise(async () => {
      {
        const setup = await fresh();
        await setup.real.current.ready();
        await setup.real.current.post("ruled", "r1");
        await setup.real.current.post("ruled", "r2");
        expect(setup.real.box.unacked.size).toBe(2);
        await tick();
        await tick();
        expect(setup.real.box.unacked.size).toBe(0);
        expect(setup.real.session.entries).toHaveLength(1);
        expect(setup.real.box.early).toEqual([]);
        expect(setup.real.current.turns()).toBe(0);
      }
    })
);
