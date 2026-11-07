import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ReaderState } from "@rat-king/ratking-client/ratking";
import { HeartbeatJson } from "@rat-king/ratking-client/reader-health";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schedule,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { harness } from "./harness.ts";
import {
  runModel,
  startReader,
  successorMailbox,
} from "./successor-fixture.ts";

const watchingParks = <A, E, R>(
  proof: (parked: Effect.Effect<boolean>) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* watchClock() {
    const clock = yield* TestClock.testClockWith(Effect.succeed);
    const parks = yield* Queue.unbounded<boolean>();

    const watched: TestClock.TestClock = {
      adjust: (duration) => clock.adjust(duration),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      setTime: (timestamp) => clock.setTime(timestamp),
      sleep: (duration) =>
        Effect.gen(function* sleep() {
          const millis = Duration.toMillis(duration);

          if (millis >= 30_000 && millis <= 35_000) {
            yield* Queue.offer(parks, true);
          }

          yield* clock.sleep(duration);
        }),
      withLive: (effect) => clock.withLive(effect),
    };

    return yield* proof(Queue.take(parks)).pipe(
      Effect.provideService(Clock.Clock, watched)
    );
  });

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.withLive(
    effect.pipe(
      Effect.retry(Schedule.spaced("1 millis")),
      Effect.timeout("5 seconds")
    )
  );

const Steps = Schema.Array(Schema.Literals(["wait", "restore"])).check(
  Schema.isMaxLength(4)
);

it.effect.prop(
  "a successor that acquired before its parent checkpoint was available retries SendOnly without claim and reads only after the checkpoint is restored",
  [Steps],
  ([steps]) =>
    watchingParks((parked) =>
      Effect.gen(function* startupRecovery() {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped();
        const server = successorMailbox();

        const layer = harness(state, server.http, [], {
          secrets: new Map<string, string>(),
        }).pipe(Layer.provideMerge(server.socket));

        const facts = {
          alive: () => false,
          env: Option.some("tester"),
          pane: Option.none<string>(),
          pid: 1,
          session: "parent",
        };

        const parent = yield* startReader(layer, facts);
        yield* parent.live;
        yield* parent.stop;
        const file = `${state}/reader-journals/tester.json`;
        yield* fs.rename(file, `${file}.saved`);

        const child = yield* startReader(layer, {
          ...facts,
          pid: 2,
          session: "child",
          succeeds: "parent",
          successor: true,
        });

        yield* child.held;
        yield* parked;

        const beat = yield* fs
          .readFileString(`${state}/readers/tester.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)));

        expect(beat.generation).toBe(0);
        expect(beat.lastError).toBe("MailboxClientError/SuccessorUnproven");
        expect(server.attempts).toHaveLength(2);
        expect(server.log.slice(-2)).toEqual(["acquire:child", "release"]);
        expect(server.requests).toHaveLength(0);

        yield* runModel(
          [...steps, "restore", "wait"],
          { restored: false },
          (model, step) =>
            Effect.gen(function* command() {
              if (step === "restore") {
                if (!model.restored) {
                  yield* fs.rename(`${file}.saved`, file);
                  model.restored = true;
                }

                return;
              }

              yield* TestClock.adjust(35_000);

              if (model.restored) {
                yield* TestClock.withLive(
                  child.live.pipe(Effect.timeout("5 seconds"))
                );
                expect(
                  ReaderState.$is("Live")((yield* child.king.status).reader)
                ).toBe(true);
              } else {
                expect(
                  ReaderState.$is("Live")((yield* child.king.status).reader)
                ).toBe(false);
                expect(server.requests).toHaveLength(0);
                yield* parked;
              }

              expect(server.maximum()).toBe(1);
            })
        );
      })
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 40_000 }
);

it.effect.prop(
  "a reader barred by its live ancestor starts reading after that lease releases or expires without claim and publishes its own heartbeat",
  { lapse: Schema.Boolean },
  ({ lapse }) =>
    watchingParks((parked) =>
      Effect.gen(function* ancestorRecovery() {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped();
        const server = successorMailbox();

        const layer = harness(state, server.http, [], {
          secrets: new Map<string, string>(),
        }).pipe(Layer.provideMerge(server.socket));

        const facts = {
          alive: () => true,
          env: Option.some("tester"),
          pane: Option.none<string>(),
          pid: 1,
          session: "parent",
        };

        const parent = yield* startReader(layer, facts);
        yield* parent.live;

        const child = yield* startReader(layer, {
          ...facts,
          ancestors: () => [1],
          pid: 2,
          session: "child",
        });

        yield* child.held;
        yield* parked;
        expect(server.attempts).toHaveLength(1);

        const beat = () =>
          fs
            .readFileString(`${state}/readers/tester.json`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)));

        expect((yield* beat()).session).toBe("parent");

        yield* runModel(
          ["held", "release", "recover"],
          { live: false },
          (model, step) =>
            Effect.gen(function* command() {
              if (step === "held") {
                yield* TestClock.adjust(35_000);
                yield* parked;
                expect(
                  ReaderState.$is("SendOnly")((yield* child.king.status).reader)
                ).toBe(true);
                expect((yield* beat()).session).toBe("parent");
                expect(server.maximum()).toBe(1);

                return;
              }

              if (step === "release") {
                if (lapse) {
                  server.failRelease();
                }

                yield* parent.stop;

                if (lapse) {
                  server.expire();
                }

                return;
              }

              yield* TestClock.adjust(35_000);
              yield* TestClock.withLive(
                child.live.pipe(Effect.timeout("5 seconds"))
              );
              model.live = true;
              expect(
                ReaderState.$is("Live")((yield* child.king.status).reader)
              ).toBe(model.live);
              yield* eventually(
                beat().pipe(
                  Effect.filterOrFail((value) => value.session === "child")
                )
              );
              expect(server.maximum()).toBe(1);
            })
        );
      })
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 }, timeout: 20_000 }
);
