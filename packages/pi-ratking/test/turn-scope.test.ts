// @effect-diagnostics asyncFunction:off -- Effect promise adapters drive the extension lifecycle.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { ratkingExtension, RECORD_EVENT } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { turnInbox, turnKey, turnWake } from "../src/wake-record.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const Name = Schema.Literals([
  "fleet/desk",
  "fleet/worker",
  "other/desk",
  "other/worker",
  "fleet",
  "switchboard",
  "/desk",
  "fleet/",
  "fleet/desk/extra",
  "",
]);

const Input = Schema.Struct({
  agent: Name,
  receiver: Name,
  seen: Schema.Boolean,
  settled: Schema.Boolean,
  state: Schema.Literals(["done", "blocked", "crashed", "working", "idle"]),
  verified: Schema.Boolean,
});

type InputValue = typeof Input.Type;

const arrival = (input: InputValue) => ({
  did: "did:web:worker.example.invalid",
  from: input.agent,
  id: "turn",
  levers: {},
  record: {
    $type: "sh.mschf.agentgraph.turn" as const,
    agent: input.agent,
    at: "2030-01-01T00:00:00Z",
    session: "session",
    state: input.state,
    turnId: "session:1",
    version: "0.1",
  },
  replyTo: Option.none<string>(),
  verified: input.verified,
});

const expected = (input: InputValue): boolean => {
  const receiver = input.receiver.split("/");
  const agent = input.agent.split("/");

  return (
    input.verified &&
    !input.settled &&
    !input.seen &&
    ["done", "blocked", "crashed"].includes(input.state) &&
    receiver.length === 2 &&
    agent.length === 2 &&
    receiver.every((part) => part.length > 0) &&
    agent.every((part) => part.length > 0) &&
    receiver[0] === agent[0]
  );
};

const nothing = () => {};

const noop = async () => {};

const ignoreDelivery: Deliver = () => Effect.void;

it.prop(
  "turn wakes require two namespaced names in the same project, terminal state, verification and fresh custody",
  [Arbitrary.schema(Input)],
  ([input]) => {
    const inbound = arrival(input);
    const seen = input.seen ? [turnKey(inbound.record)] : [];
    const acked: string[] = [];
    const displayed: unknown[] = [];

    const box = turnInbox(
      {
        consume: (id) => {
          acked.push(id);
        },
        take: (mail) => {
          displayed.push(mail);
        },
      },
      () => input.receiver
    );

    box.restore(seen, nothing);
    box.receive(inbound, input.settled);
    expect(
      Option.isSome(
        turnWake(inbound, input.settled, new Set(seen), input.receiver)
      )
    ).toBe(expected(input));
    expect(displayed).toHaveLength(expected(input) ? 1 : 0);
    expect(acked).toEqual(expected(input) ? [] : [inbound.id]);

    if (expected(input)) {
      box.shown(inbound.id);
      expect(acked).toEqual([inbound.id]);
    }
  },
  { arbitrary: { runs: 2000 } }
);

it.prop(
  "only the configured verified DID can submit another agent's crash without becoming that agent",
  {
    configured: Schema.Boolean,
    matches: Schema.Boolean,
    state: Input.fields.state,
    verified: Schema.Boolean,
  },
  ({ configured, matches, state, verified }) => {
    const alarm = "did:web:alarm.example.invalid";

    const inbound = {
      ...arrival({
        agent: "fleet/worker",
        receiver: "fleet/desk",
        seen: false,
        settled: false,
        state,
        verified,
      }),
      alarmCrashDid: configured ? alarm : undefined,
      did: matches ? alarm : "did:web:stranger.example.invalid",
      from: "ops/alarm",
    };

    const delivered: string[] = [];

    const box = turnInbox(
      {
        consume: nothing,
        take: (mail) => {
          delivered.push(mail.id);
        },
      },
      () => "fleet/desk"
    );

    box.receive(inbound, false);
    expect(delivered).toHaveLength(
      configured && matches && verified && state === "crashed" ? 1 : 0
    );
  }
);

it.effect.prop(
  "extension emits every turn record and silently settles out-of-project records without display",
  [Arbitrary.schema(Input)],
  ([input]) =>
    Effect.gen(function* scopeRouting() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      let start: (facts: SessionStart) => Promise<void> = noop;
      let stop: () => Promise<void> = noop;
      let deliver: Deliver = ignoreDelivery;

      const messages: unknown[] = [];
      const events: unknown[] = [];
      const settled: string[] = [];

      const acked = yield* Deferred.make<boolean>();

      const pi: PiHost = {
        events: {
          emit: (event, record) => {
            if (event === RECORD_EVENT) {
              events.push(record);
            }
          },
          on: () => nothing,
        },
        noteSettledRecord: (id) => {
          settled.push(id);
        },
        onSessionEnd: (handler) => {
          stop = handler;
        },
        onSessionStart: (handler) => {
          start = handler;
        },
        registerMessageRenderer: nothing,
        registerTool: nothing,
        sendMessage: (message) => {
          messages.push(message);
        },
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (session) =>
            Effect.succeed({
              alive: () => true,
              env: Option.some(input.receiver),
              pane: Option.none(),
              pid: 1,
              reads: true,
              session,
            }),
          layer: Layer.merge(
            harness(
              directory,
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
          isIdle: () => true,
          session: "receiver-session",
          shownTurns: input.seen ? [turnKey(arrival(input).record)] : [],
          warn: (message) => {
            throw new Error(message);
          },
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await stop();
        })
      );
      const inbound = arrival(input);

      yield* deliver(
        inbound,
        input.settled,
        Deferred.succeed(acked, true).pipe(Effect.asVoid)
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        from: input.agent,
        id: inbound.id,
        record: inbound.record,
        verified: input.verified,
      });
      expect(messages).toHaveLength(expected(input) ? 1 : 0);

      if (expected(input)) {
        expect(yield* Deferred.poll(acked)).toEqual(Option.none());
        expect(settled).toEqual([]);
      } else {
        yield* Deferred.await(acked);
        expect(settled).toEqual([inbound.id]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 200 } }
);
