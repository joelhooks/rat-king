import { createEventBus } from "@earendil-works/pi-coding-agent";
// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Inbox, RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import type { LeaseHolder } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { collectFacts, ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import {
  chooseName,
  heldNotice,
  heldReason,
  NameEntry,
  NAME_ENTRY,
  parseNameEntries,
} from "../src/name.ts";
import type { NameEntryValue } from "../src/name.ts";
import type { ToolParamsValue } from "../src/tool.ts";
import { quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const Entries = Schema.Array(NameEntry);

const Restorable = Schema.Struct({
  name: NameEntry.fields.name,
  source: Schema.Literals(["env", "restored"]),
});

const Defaults = Schema.Array(
  Schema.Struct({
    name: NameEntry.fields.name,
    source: Schema.Literal("default"),
  })
);

it.effect.prop(
  "an env name always wins, whatever the session entries say",
  [Arbitrary.schema(NameEntry.fields.name), Arbitrary.schema(Entries)],
  ([env, entries]) =>
    Effect.sync(() => {
      expect(chooseName({ entries, env: Option.some(env) })).toEqual({
        name: Option.some(env),
        source: "env",
      });
    })
);

it.effect.prop(
  "without env the latest env or restored entry wins and later default entries are ignored",
  [
    Arbitrary.schema(Entries),
    Arbitrary.schema(Restorable),
    Arbitrary.schema(Defaults),
  ],
  ([before, target, after]) =>
    Effect.sync(() => {
      expect(
        chooseName({
          entries: [...before, target, ...after],
          env: Option.none(),
        })
      ).toEqual({ name: Option.some(target.name), source: "restored" });
    })
);

it.effect.prop(
  "a session that only ever had default names keeps today's default",
  [Arbitrary.schema(Defaults)],
  ([entries]) =>
    Effect.sync(() => {
      expect(chooseName({ entries, env: Option.none() })).toEqual({
        name: Option.none(),
        source: "default",
      });
    })
);

it.effect.prop(
  "only well-formed ratking.name custom entries are read from a session",
  [Arbitrary.schema(Entries), Arbitrary.schema(Schema.Array(Schema.Unknown))],
  ([entries, noise]) =>
    Effect.sync(() => {
      const wrapped = entries.map((data) => ({
        customType: NAME_ENTRY,
        data,
        type: "custom",
      }));

      expect(parseNameEntries([...noise, ...wrapped])).toEqual(entries);
    })
);

const holder = (session: string): LeaseHolder => ({
  expiresAt: "2099-01-01T00:00:00.000Z",
  generation: 1,
  harness: "ratking-cli",
  live: true,
  session,
});

interface Run {
  readonly claimed: Option.Option<string>;
  readonly notices: readonly string[];
  readonly statuses: readonly (string | undefined)[];
  readonly tool: string;
}

interface Script {
  readonly env: Readonly<Record<string, string>>;
  readonly held: Option.Option<LeaseHolder>;
  readonly store: NameEntryValue[];
}

const idle = async () => {};

const until = (ready: () => boolean) =>
  Effect.sync(ready).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 millis"),
      until: (done) => done,
    })
  );

interface ExecutableTool {
  readonly execute: (
    id: string,
    call: ToolParamsValue,
    signal: AbortSignal | undefined,
    update: undefined,
    context: Readonly<Record<string, never>>
  ) => Promise<{
    readonly content: readonly { readonly text?: string }[];
  }>;
}

const isExecutable = (value: unknown): value is ExecutableTool =>
  Predicate.hasProperty(value, "execute") &&
  Predicate.isFunction(value.execute);

const session = (script: Script) =>
  Effect.gen(function* restoreSession() {
    const fs = yield* FileSystem.FileSystem;
    const state = yield* fs.makeTempDirectoryScoped();
    const notices: string[] = [];
    const statuses: (string | undefined)[] = [];
    let claimed = Option.none<string>();
    let reader: ReaderState = ReaderState.Starting({ reason: "starting" });
    let started: (start: SessionStart) => Promise<void> = idle;
    let ended: () => Promise<void> = idle;
    let tool: ExecutableTool | undefined;

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

            const publish = (next: ReaderState) => {
              reader = next;
              facts.onState?.(next);
            };

            claimed = Option.some(name);
            publish(ReaderState.Minting({ name }));
            publish(ReaderState.Acquiring({ did: "did:web:x.invalid", name }));

            if (Option.isNone(script.held)) {
              publish(
                ReaderState.Live({
                  did: "did:web:x.invalid",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  generation: 1,
                  name,
                })
              );
            }
          }),
        status: Effect.sync(() => ({
          endpoint: "https://mailbox.example.invalid",
          openAsks: 0,
          quarantine: { count: 0, latest: Option.none() },
          reader,
          self: Option.none(),
        })),
      }),
      Layer.mock(Inbox, { holder: Effect.sync(() => script.held) })
    );

    const pi: PiHost = {
      events: createEventBus(),
      onSessionEnd: (handler) => {
        ended = handler;
      },
      onSessionStart: (handler) => {
        started = handler;
      },
      registerMessageRenderer: () => {},
      registerTool: (definition) => {
        if (isExecutable(definition)) {
          tool = definition;
        }
      },
      sendMessage: () => {},
    };

    yield* Effect.promise(async () => {
      await ratkingExtension({
        facts: (id, label, interactive, entries) =>
          collectFacts(id, label, interactive, entries).pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: script.env }))
            )
          ),
        layer,
        tool: Effect.succeed("ratking"),
      })(pi);

      await startSession(started, {
        interactive: true,
        names: [...script.store],
        rememberName: (entry) => {
          script.store.push(entry);
        },
        session: "revived",
        status: (text) => {
          statuses.push(text);
        },
        warn: (message) => {
          notices.push(message);
        },
      });
    });

    if (Option.isSome(script.held)) {
      yield* until(() => notices.length > 0).pipe(
        Effect.timeoutOption("500 millis")
      );
    }

    const text = yield* Effect.promise(async () => {
      const result = await tool?.execute(
        "call",
        { action: "status" },
        undefined,
        undefined,
        {}
      );

      return result?.content.map((part) => part.text ?? "").join("") ?? "";
    });

    yield* Effect.promise(async () => {
      await ended();
    });

    return { claimed, notices, statuses, tool: text } satisfies Run;
  }).pipe(Effect.scoped);

it.live(
  "a revived session reclaims its recorded name, or degrades loudly and never defaults",
  () =>
    Effect.gen(function* revive() {
      const script: Script = {
        env: { RATKING_NAME: "switchboard" },
        held: Option.none(),
        store: [],
      };

      const first = yield* session(script);

      expect(first.claimed).toEqual(Option.some("switchboard"));
      expect(script.store).toEqual([
        { name: "switchboard", session: "revived", source: "env" },
      ]);

      const reclaimed = yield* session({ ...script, env: {} });

      expect(reclaimed.claimed).toEqual(Option.some("switchboard"));
      expect(script.store).toHaveLength(1);
      expect(reclaimed.notices).toEqual([]);

      const taken = yield* session({
        ...script,
        env: {},
        held: Option.some(holder("another-pi")),
      });

      expect(taken.claimed).toEqual(Option.some("switchboard"));
      expect(taken.notices).toEqual([heldNotice("switchboard")]);
      expect(taken.statuses.at(-1)).toBe(heldNotice("switchboard"));
      expect(taken.tool).not.toContain("NotConfigured");
      expect(taken.tool).not.toContain(heldReason("switchboard"));
      expect(script.store).toHaveLength(1);

      const override = yield* session({
        ...script,
        env: { RATKING_NAME: "ea" },
      });

      expect(override.claimed).toEqual(Option.some("ea"));
      expect(script.store.at(-1)).toEqual({
        name: "ea",
        session: "revived",
        source: "env",
      });
    }).pipe(Effect.provide(NodeServices.layer))
);

it.live("a session that only ever had a default name is never restored", () =>
  Effect.gen(function* defaults() {
    const script: Script = { env: {}, held: Option.none(), store: [] };

    const first = yield* session(script);

    expect(first.claimed).toEqual(Option.some("pi-default"));
    expect(script.store).toEqual([
      { name: "pi-default", session: "revived", source: "default" },
    ]);

    const again = yield* session({
      ...script,
      held: Option.some(holder("another-pi")),
    });

    expect(again.notices).toEqual([]);
    expect(again.tool).not.toContain(heldReason("pi-default"));
  }).pipe(Effect.provide(NodeServices.layer))
);
