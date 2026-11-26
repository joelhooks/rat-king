// @effect-diagnostics asyncFunction:off -- Pi session hooks are the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Prefs from "@rat-king/lexicon/attention.prefs";
import { RatKing } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vitest";

import { defaultPreferences } from "../../mailbox-client/src/attention.ts";
import { ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { ShadowRow } from "../src/jev-shadow.ts";
import { WAKE_RECORD } from "../src/wake-record.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const nothing = () => {};

const idle = async () => {};

const noDelivery: Deliver = () => Effect.void;

const readerName = "fleet/desk";

const JournalLine = Schema.fromJsonString(ShadowRow);

const exercise = (
  enabled: boolean,
  record: boolean,
  route: "wake" | "quiet" | "digest" | "hide"
) =>
  Effect.gen(function* buildReader() {
    const fs = yield* FileSystem.FileSystem;
    const state = yield* fs.makeTempDirectoryScoped();
    const permit = yield* Deferred.make<boolean>();
    const calls = yield* Deferred.make<boolean>();
    const messages: Parameters<PiHost["sendMessage"]>[] = [];
    let start: (session: SessionStart) => Promise<void> = idle;
    let stop: () => Promise<void> = idle;
    let startTurn: () => Promise<void> = idle;
    let endTurn: (messages: readonly unknown[]) => Promise<void> = idle;
    let deliver = noDelivery;

    const pi: PiHost = {
      events: { emit: nothing, on: () => nothing },
      onAgentEnd: (handler) => {
        endTurn = handler;
      },
      onAgentStart: (handler) => {
        startTurn = handler;
      },
      onSessionEnd: (handler) => {
        stop = handler;
      },
      onSessionStart: (handler) => {
        start = handler;
      },
      registerMessageRenderer: nothing,
      registerTool: nothing,
      sendMessage: (...args) => {
        messages.push(args);
      },
    };

    const install = ratkingExtension({
      facts: (session) =>
        Effect.succeed({
          alive: () => true,
          env: Option.some(readerName),
          pane: Option.none(),
          pid: 1,
          reads: true,
          session,
        }),
      layer: Layer.merge(
        harness(
          state,
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
    });

    yield* Effect.promise(async () => {
      await install(pi);
    });
    yield* Effect.promise(async () => {
      await startSession(start, {
        classifyJev: () =>
          Deferred.succeed(calls, true).pipe(
            Effect.andThen(Deferred.await(permit)),
            Effect.as({ inputTokens: 11, outputTokens: 2, probability: 0.01 })
          ),
        isIdle: () => true,
        session: "jev-test",
        warn: nothing,
      });
    });
    yield* Effect.addFinalizer(() => Effect.promise(stop));

    const rule = yield* Schema.decodeEffect(Prefs.Rule)(
      route === "digest"
        ? { id: "rule", match: {}, minutes: 10, route }
        : { id: "rule", match: {}, route }
    );

    const prefs = { ...defaultPreferences(), rules: [rule] };

    const base = {
      did: "did:web:worker.example.invalid",
      encrypted: false,
      from: "fleet/worker",
      id: "envelope",
      levers: {
        enabled: true,
        prefs: enabled
          ? {
              ...prefs,
              model: {
                body: "full" as const,
                jev: { judgment: "question", laterBp: 1000, nowBp: 8000 },
                kind: "jev" as const,
                timeoutMs: 2000,
              },
            }
          : prefs,
      },
      replyTo: Option.none<string>(),
      verified: true,
    };

    const marker = "synthetic mail body must not leak";
    yield* deliver(
      record
        ? {
            ...base,
            record: {
              $type: WAKE_RECORD,
              finishedAt: "2026-01-01T00:01:00Z",
              kind: "pane_output",
              label: "Worker",
              result: "result",
              source: "herdr_watch",
              startedAt: "2026-01-01T00:00:00Z",
              status: "failed",
              text: marker,
              watch: "watch-a",
            },
          }
        : {
            ...base,
            body: marker,
            cc: false,
            kind: "message",
            label: Option.none(),
            summary: Option.some("synthetic summary must not leak"),
          },
      false
    );
    const delivery = [...messages];
    const woken = delivery.filter(([, opts]) => opts?.triggerTurn === true);
    expect(woken).toHaveLength(route === "wake" ? 1 : 0);

    const path = `${state}/jev-shadow/fleet.desk.jsonl`;

    if (!enabled) {
      expect(yield* Deferred.poll(calls)).toEqual(Option.none());
      expect(yield* fs.exists(path)).toBe(false);

      return delivery;
    }

    yield* Deferred.await(calls);
    expect(yield* fs.exists(path)).toBe(false);

    if (woken.length > 0) {
      yield* Effect.promise(startTurn);
      yield* Effect.promise(async () => {
        await endTurn([
          ...woken.map(([message]) => ({ ...message, role: "custom" })),
          { role: "toolResult" },
        ]);
      });
    }

    yield* Deferred.succeed(permit, true);

    const raw = yield* fs.readFileString(path).pipe(
      Effect.filterOrFail(
        (text) => text.split("\n").length === (woken.length === 0 ? 2 : 3),
        () => "waiting for complete rows" as const
      ),
      Effect.retry(Schedule.spaced("5 millis")),
      Effect.timeout("1 second")
    );

    expect(raw).not.toContain(marker);
    expect(raw).not.toContain("synthetic summary must not leak");

    const rows = yield* Schema.decodeEffect(Schema.Array(JournalLine))(
      raw.trimEnd().split("\n")
    );

    const status = yield* fs.stat(path);
    expect(status.mode % 512).toBe(0o600);

    const verdicts = {
      digest: "Later",
      hide: "Never",
      quiet: "Next",
      wake: "Now",
    } as const;

    expect(rows).toContainEqual(
      expect.objectContaining({
        rule: verdicts[route],
        type: "score",
        verdict: "quiet",
      })
    );

    if (woken.length > 0) {
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: "envelope",
          outcome: "acted",
          type: "outcome",
        })
      );
    }

    return delivery;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live.prop(
  "shadow never changes rule verdict or Pi delivery, even when Jev would quiet a wake and cannot finish until after delivery",
  [Schema.Boolean, Schema.Literals(["wake", "quiet", "digest", "hide"])],
  ([record, route]) =>
    Effect.gen(function* nonInterference() {
      const off = yield* exercise(false, record, route);
      const on = yield* exercise(true, record, route);
      expect(on).toEqual(off);
    }),
  { arbitrary: { runs: 24 } }
);
