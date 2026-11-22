// @effect-diagnostics asyncFunction:off -- fast-check drives Pi's Promise lifecycle boundary.
import { it } from "@effect/vitest";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import { Arbitrary, Effect, Layer, Option, Schema } from "effect";
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

const nothing = () => {};

const idle = async () => {};

const ignoreShown = (_id: string) => {};

const ignoreDelivery: Deliver = () => Effect.void;

const settle = async () => {
  // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- lets fire-and-forget display acknowledgments complete.
  await Effect.runPromise(Effect.yieldNow.pipe(Effect.repeat({ times: 3 })));
};

const Kind = Schema.Literals(["cc", "quiet"]);

const Run = Schema.Literals(["prompt", "custom", "continuation"]);

const reader = async () => {
  let start: (facts: SessionStart) => Promise<void> = idle;
  let stop: () => Promise<void> = idle;
  let before = nothing;
  let agentStart: () => Promise<void> = idle;
  let turnEnd = nothing;
  let shown = ignoreShown;
  let deliver = ignoreDelivery;
  let streaming = false;
  const entries: HistoryEntry[] = [];
  const next: Message[] = [];
  const sent: Message[] = [];
  const acks = new Map<string, number>();
  const early: string[] = [];

  const pi: PiHost = {
    events: { emit: nothing, on: () => nothing },
    onAgentStart: (handler) => {
      agentStart = handler;
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
    sendMessage: (message, delivery) => {
      sent.push(message);

      expect(delivery).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
      next.push(message);
    },
    shownInSession: () => shownInHistory(entries),
  };

  await ratkingExtension({
    facts: (session) =>
      Effect.succeed({
        alive: () => true,
        env: Option.none(),
        pane: Option.none(),
        pid: 1,
        session,
      }),
    layer: Layer.merge(
      harness(
        "state.invalid",
        HttpClient.make(() => Effect.die("Unexpected HTTP"))
      ),
      Layer.mock(RatKing, {
        run: (_facts, handler) =>
          Effect.sync(() => {
            deliver = handler;
          }),
      })
    ),
    tool: Effect.succeed("ratking"),
  })(pi);
  await startSession(start, {
    isIdle: () => !streaming,
    session: "quiet-display",
    warn: nothing,
  });

  const post = async (kind: typeof Kind.Type, id: string) => {
    const inbound: Inbound = {
      body: `Mail ${id}`,
      cc: kind === "cc",
      copy: kind === "cc",
      did: "did:web:sender.invalid",
      from: "sender",
      id,
      kind: "message",
      label: Option.none(),
      quiet: kind === "quiet",
      replyTo: Option.none(),
      summary: Option.none(),
      verified: true,
    };

    // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- drives the real extension's reader callback from a model command.
    await Effect.runPromise(
      deliver(
        inbound,
        false,
        Effect.sync(() => {
          if (!shownInHistory(entries).has(id)) {
            early.push(id);
          }

          acks.set(id, (acks.get(id) ?? 0) + 1);
        })
      )
    );
    await settle();
  };

  return {
    acks,
    early,
    entries,
    post,
    record: async (messages: readonly Message[]) => {
      for (const message of messages) {
        entries.push({
          customType: message.customType,
          details: message.details,
          type: "custom_message",
        });
      }

      turnEnd();
      await settle();
    },
    run: async (kind: typeof Run.Type) => {
      streaming = true;

      if (kind === "continuation") {
        turnEnd();
      } else {
        before();
        await agentStart();
      }

      const messages = kind === "continuation" ? [] : next.splice(0);

      streaming = false;

      for (const message of messages) {
        for (const id of shownIds({ ...message, role: "custom" })) {
          shown(id);
        }
      }

      await settle();

      return messages;
    },
    sent,
    stop: async () => {
      await stop();
    },
  };
};

type Reader = Awaited<ReturnType<typeof reader>>;

interface Model {
  readonly pending: Set<string>;
  readonly displayed: Set<string>;
  ids: number;
}

interface Real {
  readonly reader: Reader;
}

const verify = (model: Model, real: Real) => {
  expect(real.reader.early).toEqual([]);
  expect(shownInHistory(real.reader.entries)).toEqual(model.displayed);

  for (let n = 1; n <= model.ids; n += 1) {
    const id = `m${n}`;
    expect(real.reader.acks.get(id) ?? 0).toBe(model.displayed.has(id) ? 1 : 0);
  }
};

const postCommand = (kind: typeof Kind.Type): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    model.ids += 1;
    const id = `m${model.ids}`;
    const sends = real.reader.sent.length;
    await real.reader.post(kind, id);
    model.pending.add(id);
    expect(real.reader.sent).toHaveLength(sends);
    verify(model, real);
  },
  toString: () => `post ${kind}`,
});

const runCommand = (kind: typeof Run.Type): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const messages = await real.reader.run(kind);

    const ids = messages.flatMap((message) =>
      shownIds({ ...message, role: "custom" })
    );

    if (kind === "continuation") {
      expect(ids).toEqual([]);
      verify(model, real);

      return;
    }

    expect(new Set(ids)).toEqual(model.pending);
    expect(ids).toHaveLength(model.pending.size);
    verify(model, real);
    await real.reader.record(messages);

    for (const id of model.pending) {
      model.displayed.add(id);
    }

    model.pending.clear();
    verify(model, real);
  },
  toString: () => `run ${kind}`,
});

it.effect.prop(
  "quiet copies only enter an independent prompt or custom run, and events without a display entry never ack them",
  [
    Arbitrary.schema(Kind),
    Arbitrary.schema(Run),
    Arbitrary.array(Arbitrary.schema(Kind), { maxLength: 8, minLength: 1 }),
  ],
  ([kind, run, kinds]) =>
    Effect.promise(async () => {
      const r = await reader();

      try {
        const setup = {
          model: {
            displayed: new Set<string>(),
            ids: 0,
            pending: new Set<string>(),
          },
          real: { reader: r },
        };

        const commands = [
          postCommand(kind),
          runCommand(run),
          ...kinds.map(postCommand),
          runCommand("continuation"),
          runCommand("prompt"),
        ];

        await asyncModelRun(() => setup, commands);
      } finally {
        await r.stop();
      }
    })
);
