import { createEventBus } from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import type { Deliver } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  ConfigProvider,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { constVoid } from "effect/Function";
import { HttpClient } from "effect/http";
import { expect, vi } from "vitest";
import { SimulatedClock } from "xstate";

import { drainSetting } from "../src/drained.ts";
import { ratkingExtension } from "../src/extension.ts";
import type { ExtensionOptions, PiHost } from "../src/extension.ts";
import { heldReason } from "../src/name.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";
import { startSession } from "./start-session.ts";
import { didOf } from "./thread-fixture.ts";

const WINDOW = 60_000;

const live = ReaderState.Live({
  did: didOf("tester"),
  expiresAt: "2099-01-01T00:00:00.000Z",
  generation: 1,
  name: "tester",
});

const Between = Schema.Int.check(
  Schema.isBetween({ maximum: WINDOW - 1, minimum: 1 })
);

const desk = Effect.fn("Test.drainDesk")(function* launch(
  layer: ExtensionOptions["layer"],
  setting: Readonly<Record<string, string>>
) {
  const clock = new SimulatedClock();
  const closed = yield* Deferred.make<string>();
  const warnings: string[] = [];
  let idle = true;
  let queued = false;

  const pi = {
    events: createEventBus(),
    onAgentSettled: vi.fn<NonNullable<PiHost["onAgentSettled"]>>(),
    onBeforeAgentStart: vi.fn<NonNullable<PiHost["onBeforeAgentStart"]>>(),
    onMessageShown: vi.fn<NonNullable<PiHost["onMessageShown"]>>(),
    onSessionEnd: vi.fn<PiHost["onSessionEnd"]>(),
    onSessionStart: vi.fn<PiHost["onSessionStart"]>(),
    registerMessageRenderer: constVoid,
    registerTool: constVoid,
    sendMessage: constVoid,
  } satisfies PiHost;

  const install = ratkingExtension({
    drainClock: clock,
    drainSetting: drainSetting.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(setting)))
    ),
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
  });

  yield* Effect.promise(install.bind(undefined, pi));

  const end = yield* Effect.fromNullishOr(pi.onSessionEnd.mock.lastCall?.[0]);

  const start = yield* Effect.fromNullishOr(
    pi.onSessionStart.mock.lastCall?.[0]
  );

  yield* Effect.addFinalizer(() => Effect.promise(end));

  const begin = Effect.promise(
    startSession.bind(undefined, start, {
      exitDrained: (reader) => {
        Deferred.doneUnsafe(closed, Effect.succeed(reader));
      },
      hasPendingMessages: () => queued,
      isIdle: () => idle,
      session: "drain-test",
      warn: (text) => {
        warnings.push(text);
      },
    })
  );

  yield* begin;

  return {
    begin,
    clock,
    closed: Deferred.await(closed).pipe(Effect.timeout("2 seconds")),
    exiting: Deferred.isDone(closed),
    setIdle: (value: boolean) => {
      idle = value;

      const handler = value ? pi.onAgentSettled : pi.onBeforeAgentStart;
      handler.mock.lastCall?.[0]();
    },
    setQueued: (value: boolean) => {
      queued = value;
      pi.onAgentSettled.mock.lastCall?.[0]();
    },
    shown: (id: string) => {
      pi.onMessageShown.mock.lastCall?.[0](id);
    },
    warnings,
  };
});

const enabled = { RATKING_EXIT_WHEN_DRAINED: "1" };

const stubReader = Effect.fn("Test.drainStubReader")(function* make(
  mode: "live" | "send-only"
) {
  const fs = yield* FileSystem.FileSystem;

  const started = yield* Deferred.make<{
    deliver: Deliver;
    drained: (value: boolean) => void;
  }>();

  const state = yield* fs.makeTempDirectoryScoped();

  const layer = Layer.merge(
    harness(
      state,
      HttpClient.make(() => Effect.die("Unexpected mailbox request"))
    ),
    Layer.mock(RatKing, {
      run: (facts, deliver, drained) =>
        Effect.sync(() => {
          facts.onState?.(
            mode === "live"
              ? live
              : ReaderState.SendOnly({
                  name: "tester",
                  reason: heldReason("tester"),
                })
          );

          Deferred.doneUnsafe(
            started,
            Effect.succeed({ deliver, drained: drained ?? constVoid })
          );
        }),
    })
  );

  return { layer, reader: Deferred.await(started) };
});

const mail = {
  body: "hello",
  cc: false,
  did: didOf("sender"),
  from: "sender",
  id: "message",
  kind: "message" as const,
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.none(),
  verified: true,
};

it.live.prop(
  "mail and turns restart the window; queued and unacknowledged mail prevent it from expiring",
  [Arbitrary.schema(Between)],
  ([elapsed]) =>
    Effect.gen(function* prove() {
      const fixture = yield* stubReader("live");
      const session = yield* desk(fixture.layer, enabled);
      const reader = yield* fixture.reader;
      const ack = yield* Deferred.make<boolean>();

      reader.drained(true);
      session.clock.increment(elapsed);
      yield* reader.deliver(mail, true);
      session.clock.increment(WINDOW - 1);
      session.setIdle(false);
      session.setIdle(true);
      session.clock.increment(WINDOW - 1);
      expect(yield* session.exiting).toBe(false);
      session.setIdle(false);
      session.clock.increment(WINDOW);
      session.setIdle(true);
      session.clock.increment(elapsed);
      session.setQueued(true);
      session.clock.increment(WINDOW);
      session.setQueued(false);
      yield* reader.deliver(
        mail,
        false,
        Deferred.succeed(ack, true).pipe(Effect.asVoid)
      );
      session.clock.increment(WINDOW);
      expect(yield* session.exiting).toBe(false);

      session.shown(mail.id);
      yield* Deferred.await(ack).pipe(Effect.timeout("2 seconds"));
      session.clock.increment(WINDOW - 1);
      expect(yield* session.exiting).toBe(false);

      session.clock.increment(1);
      expect(yield* session.closed).toBe("live");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } }
);

it.live.prop(
  "only an enabled idle lease loser exits; bad values warn once and empty or absent values stay quiet",
  [
    Arbitrary.schema(
      Schema.Literals(["absent", "", "garbage", "0", "Infinity"])
    ),
  ],
  ([value]) =>
    Effect.gen(function* prove() {
      const fixture = yield* stubReader("send-only");

      const config =
        value === "absent" ? {} : { RATKING_EXIT_WHEN_DRAINED: value };

      const inactive = yield* desk(fixture.layer, config);

      yield* inactive.begin;
      inactive.clock.increment(2 * WINDOW);
      expect(yield* inactive.exiting).toBe(false);
      expect(
        inactive.warnings.filter((text) =>
          text.includes("RATKING_EXIT_WHEN_DRAINED")
        )
      ).toHaveLength(value === "absent" || value === "" ? 0 : 1);

      const active = yield* desk(fixture.layer, enabled);

      active.clock.increment(WINDOW - 1);
      expect(yield* active.exiting).toBe(false);
      active.clock.increment(1);
      expect(yield* active.closed).toBe("send-only");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 } }
);

it.live.prop(
  "lease release completes before Pi shutdown, and work arriving during release reopens the reader",
  [Arbitrary.schema(Schema.Boolean)],
  ([workDuringRelease]) =>
    Effect.gen(function* prove() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const mailbox = fakeMailbox("accept");
      const canPoll = yield* Deferred.make<boolean>();
      const polling = yield* Deferred.make<boolean>();
      const caughtUp = yield* Deferred.make<boolean>();
      const caughtUpAgain = yield* Deferred.make<boolean>();
      const canRelease = yield* Deferred.make<boolean>();
      const releasing = yield* Deferred.make<boolean>();
      let acquires = 0;
      let releases = 0;

      const http = HttpClient.make((request) =>
        Effect.gen(function* serve() {
          const nsid = new URL(request.url).pathname;

          if (nsid.endsWith(".acquireLease")) {
            acquires += 1;
          }

          if (acquires > 0 && nsid.endsWith(".list")) {
            yield* Deferred.succeed(polling, true);
            yield* Deferred.await(canPoll);
          }

          if (nsid.endsWith(".releaseLease")) {
            yield* Deferred.succeed(releasing, true);
            yield* Deferred.await(canRelease);
            releases += 1;
          }

          return yield* mailbox.http.execute(request);
        })
      );

      const layer = Layer.effect(
        RatKing,
        RatKing.use((king) =>
          Effect.succeed(
            RatKing.of({
              ...king,
              run: (facts, deliver, observe) =>
                king.run(facts, deliver, (drained) => {
                  observe?.(drained);

                  if (drained) {
                    Deferred.doneUnsafe(
                      acquires === 1 ? caughtUp : caughtUpAgain,
                      Effect.succeed(true)
                    );
                  }
                }),
            })
          )
        )
      ).pipe(
        Layer.provideMerge(harness(state, http)),
        Layer.provideMerge(quietSocket)
      );

      const session = yield* desk(layer, enabled);

      yield* Effect.addFinalizer(() => Deferred.succeed(canRelease, true));
      yield* Deferred.await(polling).pipe(Effect.timeout("2 seconds"));
      session.clock.increment(2 * WINDOW);
      expect(yield* Deferred.isDone(releasing)).toBe(false);
      yield* Deferred.succeed(canPoll, true);
      yield* Deferred.await(caughtUp).pipe(Effect.timeout("2 seconds"));
      session.clock.increment(WINDOW - 1);
      expect(yield* Deferred.isDone(releasing)).toBe(false);
      session.clock.increment(1);
      yield* Deferred.await(releasing).pipe(Effect.timeout("2 seconds"));
      expect(yield* session.exiting).toBe(false);

      if (workDuringRelease) {
        session.setIdle(false);
      }

      yield* Deferred.succeed(canRelease, true);

      if (workDuringRelease) {
        yield* Deferred.await(caughtUpAgain).pipe(Effect.timeout("2 seconds"));
        expect(yield* session.exiting).toBe(false);
        session.setIdle(true);
        session.clock.increment(WINDOW);
      }

      expect(yield* session.closed).toBe("live");
      expect(releases).toBe(workDuringRelease ? 2 : 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);
