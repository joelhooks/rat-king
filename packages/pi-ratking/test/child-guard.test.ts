import { createEventBus } from "@earendil-works/pi-coding-agent";
// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary under test.
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  blockedByAncestor,
  HeartbeatJson,
  ReaderHeartbeat,
} from "@rat-king/ratking-client/reader-health";
import type { ReaderHeartbeatValue } from "@rat-king/ratking-client/reader-health";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { ancestorsOf } from "../src/ancestry.ts";
import { ratkingExtension } from "../src/extension.ts";
import type { PiHost, SessionStart } from "../src/extension.ts";
import { heldNotice, heldReason } from "../src/name.ts";
import { quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";

const Pids = Schema.Array(
  Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 1 }))
);

it.effect.prop(
  "a heartbeat blocks exactly when its pid is a live ancestor and its session differs; an absent heartbeat never blocks",
  [
    Arbitrary.schema(ReaderHeartbeat),
    Arbitrary.schema(Pids),
    Arbitrary.schema(Schema.String),
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([drawn, others, session, ancestor, live, sameSession]) =>
    Effect.sync(() => {
      const beat: ReaderHeartbeatValue = {
        ...drawn,
        pid: 1000,
        session: sameSession ? session : `${session}-other`,
      };

      const chain = ancestor ? [...others, 1000] : others;

      expect(
        blockedByAncestor(Option.some(beat), chain, session, () => live)
      ).toBe(ancestor && live && !sameSession);
      expect(blockedByAncestor(Option.none(), chain, session, () => live)).toBe(
        false
      );
    })
);

it.effect.prop(
  "the ancestor walk follows parents to the root and stops on cycles",
  [
    Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 5000, minimum: 2 }))
      ).check(Schema.isMaxLength(20))
    ),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([drawn, cyclic]) =>
    Effect.sync(() => {
      const chain = [...new Set(drawn)];
      const [self, ...above] = [1, ...chain];

      const parents = new Map(
        [self, ...above].map((pid, index, all) => [
          pid,
          all[index + 1] ?? (cyclic ? (above[0] ?? null) : null),
        ])
      );

      expect(ancestorsOf(self, (pid) => parents.get(pid) ?? null)).toEqual(
        above
      );
    })
);

const idle = async () => {};

const HOLDER = 4242;

const SCENARIOS = {
  child: {
    ancestors: [7, HOLDER],
    blocked: true,
    holderAlive: true,
    sameSession: false,
  },
  holderGone: {
    ancestors: [7, HOLDER],
    blocked: false,
    holderAlive: false,
    sameSession: false,
  },
  sameSession: {
    ancestors: [7, HOLDER],
    blocked: false,
    holderAlive: true,
    sameSession: true,
  },
  unrelated: {
    ancestors: [7, 8],
    blocked: false,
    holderAlive: true,
    sameSession: false,
  },
} as const;

const Scenario = Schema.Literals([
  "child",
  "holderGone",
  "sameSession",
  "unrelated",
]);

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry(
      Schedule.spaced("20 millis").pipe(
        Schedule.while(({ attempt }) => attempt < 250)
      )
    )
  );

it.live.prop(
  "a Pi under a live holder's process tree never acquires that name's lease and stays able to send; any other Pi with the name does",
  [Arbitrary.schema(Scenario)],
  ([which]) =>
    Effect.gen(function* childProof() {
      const scenario = SCENARIOS[which];
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];
      const now = yield* Clock.currentTimeMillis;
      const stamp = DateTime.makeUnsafe(now);

      const held: ReaderHeartbeatValue = {
        lastConsumeOk: null,
        lastError: null,
        leaseHeldSince: null,
        name: "tester",
        pid: HOLDER,
        session: "holder-session",
        startedAt: stamp,
        state: "Live",
        updatedAt: stamp,
      };

      const text = yield* Schema.encodeEffect(HeartbeatJson)(held);

      yield* fs.makeDirectory(`${state}/readers`, { recursive: true });
      yield* fs.writeFileString(`${state}/readers/tester.json`, text);

      const http = HttpClient.make((request) =>
        Effect.gen(function* mailbox() {
          const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

          calls.push(nsid);

          if (nsid.endsWith(".acquireLease")) {
            const at = yield* Clock.currentTimeMillis;

            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                lease: {
                  did: "did:web:tester.agents.example.invalid",
                  expiresAt: DateTime.formatIso(
                    DateTime.makeUnsafe(at + 300_000)
                  ),
                  generation: 1,
                  harness: {
                    $type: "sh.mschf.ratking.runtime.lease#pi",
                    sessionId: "x",
                  },
                  leaseId: "3mxcx45mn7sex",
                },
              })
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            nsid.endsWith(".list")
              ? Response.json({ events: [], throughSeq: 0 })
              : Response.json({ error: "MailboxUnavailable" }, { status: 503 })
          );
        })
      );

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(
          {
            alive: (pid) => pid === HOLDER && scenario.holderAlive,
            ancestors: () => scenario.ancestors,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 9,
            session: scenario.sameSession ? "holder-session" : "child-session",
          },
          () => Effect.void
        );

        if (scenario.blocked) {
          const reader = yield* eventually(
            ratking.status.pipe(
              Effect.map((status) => status.reader),
              Effect.filterOrFail(ReaderState.$is("SendOnly"))
            )
          );

          yield* Effect.sleep("300 millis");

          expect(reader.reason).toBe(heldReason("tester"));
          expect(calls.some((nsid) => nsid.endsWith(".acquireLease"))).toBe(
            false
          );
          expect(yield* fs.readFileString(`${state}/readers/tester.json`)).toBe(
            text
          );
        } else {
          yield* eventually(
            ratking.status.pipe(
              Effect.filterOrFail((status) =>
                ReaderState.$is("Live")(status.reader)
              )
            )
          );

          expect(calls.some((nsid) => nsid.endsWith(".acquireLease"))).toBe(
            true
          );
        }
      }).pipe(
        Effect.provide(Layer.provideMerge(harness(state, http), quietSocket))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 }, timeout: 60_000 }
);

it.live(
  "a held send-only reader shows the loud notice and leaves sends open",
  () =>
    Effect.gen(function* noticeProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const notices: string[] = [];
      const statuses: (string | undefined)[] = [];
      let started: (start: SessionStart) => Promise<void> = idle;

      const layer = Layer.mergeAll(
        harness(
          state,
          HttpClient.make(() => Effect.die("Unexpected HTTP"))
        ),
        quietSocket,
        Layer.mock(RatKing, {
          run: (facts) =>
            Effect.sync(() => {
              facts.onState?.(
                ReaderState.SendOnly({
                  name: "tester",
                  reason: heldReason("tester"),
                })
              );
            }),
        })
      );

      const pi: PiHost = {
        events: createEventBus(),
        onSessionEnd: () => {},
        onSessionStart: (handler) => {
          started = handler;
        },
        registerMessageRenderer: () => {},
        registerTool: () => {},
        sendMessage: () => {},
      };

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: () =>
            Effect.succeed({
              alive: () => false,
              env: Option.some("tester"),
              pane: Option.none(),
              pid: 1,
              session: "s",
            }),
          layer,
          tool: Effect.succeed("ratking"),
        })(pi);

        await startSession(started, {
          interactive: true,
          session: "s",
          status: (text) => {
            statuses.push(text);
          },
          warn: (message) => {
            notices.push(message);
          },
        });
      });

      yield* eventually(
        Effect.sync(() => {
          expect(notices).toEqual([heldNotice("tester")]);
        })
      );

      expect(statuses.at(-1)).toBe(heldNotice("tester"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
