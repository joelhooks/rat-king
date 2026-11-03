/* oxlint-disable effect-tests/no-manual-effect-runtime-in-tests -- Each runtime call bridges an asyncModelRun command using the test context and its TestClock. */
/* oxlint-disable typescript/promise-function-async -- fast-check commands are Promise boundaries; the HttpClient adapter takes a callback. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  HeartbeatJson,
  READER_STUCK_MS,
} from "@rat-king/ratking-client/reader-health";
import type { ReaderHeartbeatValue } from "@rat-king/ratking-client/reader-health";
import { Clock, Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  emptySources,
  observeAlarms,
  sightReaders,
} from "../../../stacks/nest/alarm-sources.ts";
import { WebSocketPort } from "../../mailbox-client/src/watch.ts";
import { readerFooter } from "../src/tool.ts";
import { harness } from "./harness.ts";

const Step = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("run"),
    seconds: Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 })),
  }),
  Schema.Struct({ kind: Schema.Literals(["break", "heal"]) }),
]);

type StepValue = typeof Step.Type;

const baseFacts: typeof AlarmFacts.Type = {
  cacheBreaches: [],
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
};

const realTick = TestClock.withLive(Effect.sleep("2 millis"));

const settle = TestClock.withLive(Effect.sleep("25 millis"));

const idleSocket = WebSocketPort.of({
  connect: () => {
    const events = new EventTarget();

    return {
      addEventListener: (type, listener, options) => {
        events.addEventListener(type, listener, options);
      },
      close: () => {},
      readyState: 1,
      removeEventListener: (type, listener) => {
        events.removeEventListener(type, listener);
      },
      send: () => {
        events.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              $type: "sh.mschf.ratking.mailbox.subscribe#notice",
              seq: 0,
            }),
          })
        );
      },
    };
  },
});

const fakeMailbox = (control: { broken: boolean }) => {
  let generation = 0;

  return HttpClient.make((request) =>
    Effect.sync(() => {
      const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

      const input: unknown = Predicate.isTagged(request.body, "Uint8Array")
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : {};

      const field = (key: string) =>
        Predicate.hasProperty(input, key) ? input[key] : undefined;

      if (control.broken) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      if (nsid === "sh.mschf.ratking.mailbox.list") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ events: [], throughSeq: 0 })
        );
      }

      if (
        nsid === "sh.mschf.ratking.runtime.acquireLease" ||
        nsid === "sh.mschf.ratking.runtime.renewLease"
      ) {
        if (nsid.endsWith("acquireLease")) {
          generation += 1;
        }

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            lease: {
              did: field("did"),
              expiresAt: field("expiresAt"),
              generation,
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                sessionId: "model",
              },
              leaseId: "3mxcx45mn7sex",
            },
          })
        );
      }

      return HttpClientResponse.fromWeb(
        request,
        nsid === "sh.mschf.ratking.runtime.releaseLease"
          ? Response.json({})
          : Response.json({ error: "MailboxUnavailable" }, { status: 503 })
      );
    })
  );
};

interface Model {
  now: number;
  broken: boolean;
  since: number;
  progressFloor: number;
}

const RENEW_EVERY_MS = 155_000;

it.effect.prop(
  "a reader whose consume keeps failing publishes a non-running heartbeat and readers.stuck fires after 5 minutes; a healthy reader stays quiet",
  [Schema.Array(Step)],
  ([steps]) =>
    Effect.gen(function* readerHealthModel() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const file = `${state}/readers/tester.json`;
      const control = { broken: false };
      const footers: (string | undefined)[] = [];

      const readBeat = fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)));

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking
          .run(
            {
              alive: () => false,
              env: Option.some("tester"),
              onState: (reader) => {
                footers.push(readerFooter(reader));
              },
              owner: Option.some("owner-invalid"),
              pane: Option.none(),
              pid: process.pid,
              reads: true,
              session: "model-session",
            },
            () => Effect.void
          )
          .pipe(Effect.provideService(WebSocketPort, idleSocket));

        let live: Option.Option<ReaderHeartbeatValue> = Option.none();

        for (let tries = 0; tries < 2000 && Option.isNone(live); tries += 1) {
          yield* realTick;
          live = (yield* Effect.option(readBeat)).pipe(
            Option.filter((beat) => beat.state === "Live")
          );
        }

        expect(Option.isSome(live)).toBe(true);

        const processBeat = yield* fs
          .readFileString(`${state}/readers/retries/${process.pid}.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HeartbeatJson)));

        expect(processBeat.pid).toBe(process.pid);
        expect(processBeat.retries?.windowMs).toBe(60_000);

        if (Option.isSome(live)) {
          expect(
            live.value.retries?.buckets.some(
              (bucket) =>
                bucket.name === "tester" && bucket.counts.acquireOk === 1
            )
          ).toBe(true);
        }

        const context = yield* Effect.context();

        const advance = (seconds: number) =>
          Effect.gen(function* advanceClock() {
            for (let second = 0; second < seconds; second += 1) {
              yield* TestClock.adjust("1 second");
              yield* realTick;
            }
          });

        const command = (step: StepValue): AsyncCommand<Model, object> => ({
          check: () => true,
          run: (model) =>
            Effect.runPromiseWith(context)(
              Effect.gen(function* runStep() {
                if (step.kind === "run") {
                  yield* advance(step.seconds);
                  model.now += step.seconds * 1000;
                } else if ((step.kind === "break") !== model.broken) {
                  model.broken = step.kind === "break";
                  model.since = model.now;
                  control.broken = model.broken;
                }

                yield* settle;

                const beat = yield* readBeat;
                const status = yield* ratking.status;
                const now = yield* Clock.currentTimeMillis;
                const held = model.now - model.since;

                const seen = sightReaders(
                  "host-invalid",
                  [{ alive: true, beat }],
                  now
                );

                const reading = observeAlarms(
                  emptySources,
                  { ...baseFacts, readers: { complete: true, seen } },
                  now
                ).readings["readers.stuck"];

                expect(beat.name).toBe("tester");
                expect(beat.owner).toBe("owner-invalid");
                expect(beat.pid).toBe(process.pid);
                expect(footers.at(-1) === undefined).toBe(
                  ReaderState.$is("Live")(status.reader)
                );

                if (model.broken && held > READER_STUCK_MS) {
                  expect(beat.state).not.toBe("Live");
                  expect(beat.lastError).not.toBeNull();
                  expect(reading.status).toBe("firing");

                  if (reading.status === "firing") {
                    expect(reading.evidence).toContain("tester");
                    expect(reading.evidence).toContain(beat.state);
                    expect(reading.recipients).toEqual(["owner-invalid"]);
                  }
                }

                if (!model.broken && held >= 60_000) {
                  expect(beat.state).toBe("Live");
                  model.progressFloor = Math.max(
                    model.progressFloor,
                    model.now - RENEW_EVERY_MS
                  );
                }

                if (
                  model.now - model.progressFloor <
                  READER_STUCK_MS - 10_000
                ) {
                  expect(reading.status).toBe("ok");
                }
              })
            ),
          toString: () => JSON.stringify(step),
        });

        const quiet: StepValue[] = [
          { kind: "run", seconds: 120 },
          { kind: "run", seconds: 120 },
          { kind: "run", seconds: 120 },
        ];

        const outage: StepValue[] = [
          { kind: "break" },
          { kind: "run", seconds: 120 },
          { kind: "run", seconds: 120 },
          { kind: "run", seconds: 90 },
        ];

        yield* Effect.promise(() =>
          asyncModelRun(
            () => ({
              model: {
                broken: false,
                now: 0,
                progressFloor: 0,
                since: -60_000,
              },
              real: {},
            }),
            [...quiet, ...steps, ...outage].map(command)
          )
        );
      }).pipe(Effect.provide(harness(state, fakeMailbox(control))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 240_000 }
);
