import { createEventBus } from "@earendil-works/pi-coding-agent";
// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { AgentName } from "@rat-king/ratking-client/name";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  ConfigProvider,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { asyncModelRun } from "fast-check";
import { expect } from "vitest";

import { collectFacts, ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { chooseName } from "../src/name.ts";
import type { NameEntryValue } from "../src/name.ts";
import type { ToolParamsValue } from "../src/tool.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

interface Hooks {
  started?: (start: SessionStart) => Promise<void>;
}

const Session = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}$/u));

const Names = Schema.Struct({
  other: AgentName,
  parent: AgentName,
}).check(Schema.makeFilter((names) => names.other !== names.parent));

it.effect.prop(
  "a restart-born session resumed with its parent's env name keeps its own recorded name",
  [Arbitrary.schema(Names), Arbitrary.schema(Session)],
  ([{ other, parent }, session]) =>
    Effect.sync(() => {
      const parentSession = `${session}-parent`;

      const entries: readonly NameEntryValue[] = [
        { name: parent, source: "env" },
        {
          name: other,
          parent: { name: parent, session: parentSession },
          session,
          source: "forked",
        },
      ];

      expect(
        chooseName({
          entries,
          env: Option.some(parent),
          parentSession,
          session,
        })
      ).toEqual({
        name: Option.some(other),
        parent: { name: parent, session: parentSession },
        source: "restored",
      });
      expect(
        chooseName({ entries, env: Option.none(), parentSession, session })
          .source
      ).toBe("restored");
    })
);

it.effect.prop(
  "a resume with a different env name takes the env name",
  [Arbitrary.schema(Names), Arbitrary.schema(Session)],
  ([{ other, parent }, session]) =>
    Effect.sync(() => {
      expect(
        chooseName({
          entries: [{ name: other, session, source: "restored" }],
          env: Option.some(parent),
          parentSession: `${session}-parent`,
          session,
        })
      ).toEqual({ name: Option.some(parent), source: "env" });
    })
);

it.effect.prop(
  "a true fork with no entry of its own still derives from the parent",
  [Arbitrary.schema(Names), Arbitrary.schema(Session)],
  ([{ parent }, session]) =>
    Effect.sync(() => {
      const parentSession = `${session}-parent`;

      const choice = chooseName({
        entries: [{ name: parent, session: parentSession, source: "env" }],
        env: Option.some(parent),
        parentSession,
        session,
      });

      expect(choice.source).toBe("forked");
      expect(choice.parent).toEqual({ name: parent, session: parentSession });
    })
);

it("the recorded 10-15 desk evidence resumes as muster/desk", () => {
  const choice = chooseName({
    entries: [
      { name: "muster/desk", source: "env" },
      {
        name: "muster/desk",
        session: "desk-20261015T033000-9d97b522",
        source: "env",
      },
    ],
    env: Option.some("muster/desk"),
    parentSession: "desk-20261015T005548-eec68a62",
    session: "desk-20261015T033000-9d97b522",
  });

  expect(choice).toEqual({
    name: Option.some("muster/desk"),
    source: "restored",
  });
});

it.live(
  "the first start of a restart-born session records its name with its own session once",
  () =>
    Effect.gen(function* firstStart() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const store: NameEntryValue[] = [];
      const hooks: Hooks = {};

      const layer = Layer.mergeAll(
        harness(
          state,
          HttpClient.make(() => Effect.die("Unexpected HTTP"))
        ),
        quietSocket,
        Layer.mock(RatKing, {
          run: (facts) =>
            Effect.sync(() => {
              const name = Option.getOrElse(facts.env, () => "pi-default");

              facts.onState?.(
                ReaderState.Live({
                  did: "did:web:x.invalid",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  generation: 1,
                  name,
                })
              );
            }),
        })
      );

      const pi: PiHost = {
        events: createEventBus(),
        onSessionEnd: () => {},
        onSessionStart: (handler) => {
          hooks.started = handler;
        },
        registerMessageRenderer: () => {},
        registerTool: () => {},
        sendMessage: () => {},
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: (id, label, interactive, entries, parentSession) =>
            collectFacts(id, label, interactive, entries, parentSession).pipe(
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({
                    env: {
                      RATKING_NAME: "muster/desk",
                      RATKING_SUCCEEDS: "parent-1",
                    },
                  })
                )
              )
            ),
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);

        const { started } = hooks;

        if (started === undefined) {
          throw new Error("session_start was not registered");
        }

        await startSession(started, {
          interactive: true,
          names: [{ name: "muster/desk", source: "env" }],
          parentSession: "parent-1",
          rememberName: (entry) => {
            store.push(entry);
          },
          session: "child-1",
          status: () => {},
          warn: () => {},
        });
      });

      expect(store).toEqual([
        { name: "muster/desk", session: "child-1", source: "env" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const ConnectSession = Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/u));

type Handler = (args: string, print: (line: string) => void) => Promise<void>;

interface ConnectHooks {
  end?: () => Promise<void>;
  start?: (start: SessionStart) => Promise<void>;
}

interface ConnectTool {
  readonly execute: (
    id: string,
    params: ToolParamsValue,
    signal: undefined,
    update: undefined,
    context: Readonly<Record<string, never>>
  ) => Promise<{
    readonly content: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  }>;
}

const isConnectTool = (value: unknown): value is ConnectTool =>
  Predicate.hasProperty(value, "execute") &&
  Predicate.isFunction(value.execute);

it.live.prop(
  "interactive startup and repeated live connect commands preserve one reader and one saved name",
  [
    Arbitrary.schema(ConnectSession),
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([session, automatic, useTool]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const box = fakeMailbox("accept");
      const saved: NameEntryValue[] = [];
      const commands = new Map<string, Handler>();
      let connectTool: ConnectTool | undefined;

      const hooks: ConnectHooks = {};

      const live = yield* Deferred.make<boolean>();
      const expected = `pi-${session.slice(0, 8)}`;
      const env = automatic ? {} : { MUSTER_ROW: "unnamed" };

      const facts: typeof collectFacts = (
        id,
        label,
        interactive,
        entries,
        parent
      ) =>
        collectFacts(id, label, interactive, entries, parent).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
        );

      const host: PiHost = {
        events: createEventBus(),
        onSessionEnd: (handler) => {
          hooks.end = handler;
        },
        onSessionStart: (handler) => {
          hooks.start = handler;
        },
        registerCommand: (name, command) => {
          commands.set(name, command.handler);
        },
        registerMessageRenderer: () => {},
        registerTool: (tool) => {
          if (isConnectTool(tool)) {
            connectTool = tool;
          }
        },
        sendMessage: () => {},
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts,
          layer: harness(state, box.http).pipe(Layer.provideMerge(quietSocket)),
          tool: Effect.succeed("ratking"),
        })(host);
      });

      const started = yield* Effect.fromOption(
        Option.fromNullishOr(hooks.start)
      );

      const ended = yield* Effect.fromOption(Option.fromNullishOr(hooks.end));

      yield* Effect.addFinalizer(() => Effect.promise(ended));
      yield* Effect.promise(async () => {
        await startSession(started, {
          interactive: true,
          onReaderState: (reader) => {
            if (ReaderState.$is("Live")(reader)) {
              Deferred.doneUnsafe(live, Effect.succeed(true));
            }
          },
          rememberName: (entry) => {
            saved.push(entry);
          },
          session,
          warn: () => {},
        });
      });

      if (automatic) {
        yield* Deferred.await(live).pipe(Effect.timeout("5 seconds"));
      } else {
        expect(saved).toEqual([]);
        expect(box.calls).toEqual([]);
      }

      const command = commands.get("ratking");

      if (command === undefined) {
        throw new Error("Missing connect command");
      }

      if (!automatic) {
        yield* fs.writeFileString(
          `${state}/claims.json`,
          JSON.stringify({
            "held-name": { pid: process.pid, session: "holder-session" },
          })
        );
        yield* Effect.promise(async () => {
          await command("connect held-name", (line) => {
            expect(line).toContain("holder-session");
            expect(line).toContain("/ratking connect");
          });
        });
        expect(box.calls).toEqual([]);
        expect(saved).toEqual([]);
      }

      const connectCall: Handler = useTool
        ? async (args, print) => {
            if (connectTool === undefined) {
              throw new Error("Missing connect tool");
            }

            const [, name] = args.split(" ");
            const params: ToolParamsValue = { action: "connect" };

            if (name !== undefined) {
              Object.assign(params, { name });
            }

            const result = await connectTool.execute(
              "connect-call",
              params,
              undefined,
              undefined,
              {}
            );

            expect(result.isError).not.toBe(true);
            print(result.content.map((part) => part.text ?? "").join(""));
          }
        : command;

      const lines: string[] = [];
      yield* Effect.promise(async () => {
        await asyncModelRun(
          () => ({ model: { live: automatic }, real: connectCall }),
          [
            {
              check: () => true,
              run: async (model: { live: boolean }, real: Handler) => {
                await real("connect", (line) => {
                  lines.push(line);
                  expect(line).toBe(
                    model.live
                      ? `Rat King is already live as ${expected}`
                      : `Rat King is live as ${expected}`
                  );
                  model.live = true;
                });
              },
              toString: () => "connect default",
            },
            {
              check: () => true,
              run: async (model: { live: boolean }, real: Handler) => {
                await real("connect ignored-name", (line) => {
                  lines.push(line);
                  expect(model.live).toBe(true);
                  expect(line).toBe(`Rat King is already live as ${expected}`);
                });
              },
              toString: () => "connect live is a no-op",
            },
          ]
        );
      });
      expect(lines).toHaveLength(2);
      expect(saved).toEqual([
        {
          derived: true,
          name: expected,
          session,
          source: automatic ? "interactive" : "connected",
        },
      ]);
      expect(
        box.calls.filter((call) => call.endsWith(".acquireLease"))
      ).toHaveLength(1);
      const restored = yield* facts(session, undefined, true, saved);
      expect(Option.getOrUndefined(restored.env)).toBe(expected);
      expect(restored.derived).toBe(true);

      yield* Effect.promise(async () => {
        await startSession(started, {
          interactive: false,
          session: `${session}-headless`,
          warn: () => {},
        });
        await command("connect", (line) => {
          expect(line).toContain("needs an interactive Pi");
        });

        if (connectTool === undefined) {
          throw new Error("Missing connect tool");
        }

        const refused = await connectTool.execute(
          "headless-connect",
          { action: "connect", name: "unused-name" },
          undefined,
          undefined,
          {}
        );

        expect(refused.isError).toBe(true);
        expect(refused.content[0]?.text).toContain("/ratking connect");
      });
      expect(
        box.calls.filter((entry) => entry.endsWith(".acquireLease"))
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "any Muster marker suppresses auto-naming, as does a fork without a parent name",
  [
    Arbitrary.schema(ConnectSession),
    Arbitrary.schema(
      Schema.Literals(["MUSTER_ROW", "MUSTER_LANE", "MUSTER_REMOTE_ROW"])
    ),
  ],
  ([session, marker]) =>
    Effect.gen(function* proof() {
      for (const [env, parent] of [
        [{ [marker]: "row" }, undefined],
        [{}, "parent"],
      ] as const) {
        const facts = yield* collectFacts(
          session,
          undefined,
          true,
          [],
          parent
        ).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
        );

        expect(facts.nameless).toBe(true);
        expect(Option.isNone(facts.env)).toBe(true);
      }
    })
);
