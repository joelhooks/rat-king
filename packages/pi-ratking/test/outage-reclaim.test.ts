import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";

import { crashedReader } from "../../../stacks/nest/turn-crash-record.ts";
import { ReaderHeartbeat } from "../../ratking-client/src/reader-health.ts";
import { runEffectModel } from "../../ratking-client/test/pass-launcher-model.ts";
import { fakeMailbox, quietSocket } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

const TTL_MS = 300_000;

const RETRY_BOUND_MS = 150_000;

const Case = Schema.Struct({
  holderIsSelf: Schema.Boolean,
  holderMs: Schema.Int.check(
    Schema.isBetween({ maximum: 1_000_000, minimum: 0 })
  ),
  outageMs: Schema.Int.check(
    Schema.isBetween({ maximum: 420_000, minimum: 20_000 })
  ),
  outageStartMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 0 })
  ),
  slow: Schema.Boolean,
  successor: Schema.Boolean,
});

interface Server {
  holder: string;
  listed: boolean;
  outageFrom: number;
  outageUntil: number;
  serial: number;
  until: number;
}

const settle = TestClock.withLive(Effect.sleep("5 millis"));

const memoryFiles = () => {
  const files = new Map<string, string>();
  const absent = FileSystem.makeNoop({});

  return FileSystem.makeNoop({
    exists: (file) => Effect.sync(() => files.has(file)),
    makeDirectory: () => Effect.void,
    readFileString: (file) =>
      Effect.suspend(() => {
        const value = files.get(file);

        return value === undefined
          ? absent.readFileString(file)
          : Effect.succeed(value);
      }),
    remove: (file) =>
      Effect.sync(() => {
        files.delete(file);
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        const value = files.get(from);

        if (value !== undefined) {
          files.set(to, value);
          files.delete(from);
        }
      }),
    writeFileString: (file, text) =>
      Effect.sync(() => {
        files.set(file, text);
      }),
  });
};

const stamp = (until: number) => DateTime.formatIso(DateTime.makeUnsafe(until));

const respond = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  body: typeof Schema.Json.Type,
  status = 200
) => HttpClientResponse.fromWeb(request, Response.json(body, { status }));

const decode = <A, I>(
  schema: Schema.Codec<A, I>,
  request: Parameters<typeof respond>[0]
) =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        new TextDecoder().decode(request.body.body)
      ).pipe(Effect.orDie)
    : Effect.die("no body");

const lease = (server: Server, did: string) => ({
  did,
  expiresAt: stamp(server.until),
  generation: server.serial,
  harness: {
    $type: "sh.mschf.ratking.runtime.lease#pi",
    sessionId: server.holder,
  },
  leaseId: "3mxcx45mn7sxx",
});

const serve = (server: Server, session: string, slow: boolean) => {
  const mailbox = fakeMailbox("accept");

  return HttpClient.make((request) =>
    Effect.gen(function* handle() {
      const nsid = new URL(request.url).pathname;
      const now = yield* Clock.currentTimeMillis;
      const held = server.until > now;

      if (now >= server.outageFrom && now < server.outageUntil) {
        return slow
          ? yield* Effect.never
          : respond(request, { error: "MailboxUnavailable" }, 503);
      }

      if (nsid.endsWith(".acquireLease")) {
        const input = yield* decode(Acquire.Input, request);

        if (held) {
          return respond(request, { error: "LeaseHeld" }, 409);
        }

        server.serial += 1;
        server.holder = session;
        server.until = now + TTL_MS;

        return respond(request, { lease: lease(server, input.did) });
      }

      if (nsid.endsWith(".renewLease")) {
        const input = yield* decode(Renew.Input, request);

        if (!held || input.generation !== server.serial) {
          return respond(request, { error: "LeaseExpired" }, 409);
        }

        server.until = now + TTL_MS;

        return respond(request, { lease: lease(server, input.did) });
      }

      if (nsid.endsWith(".resolveLease")) {
        const did = new URL(request.url).searchParams.get("did") ?? "";

        return held
          ? respond(request, { lease: lease(server, did) })
          : respond(request, { error: "LeaseNotFound" }, 404);
      }

      if (nsid.endsWith(".list")) {
        server.listed = true;
      }

      return yield* mailbox.http.execute(request);
    })
  );
};

const advance = (millis: number, settled = settle) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(millis / 1000) }),
    () => TestClock.adjust(1000).pipe(Effect.andThen(settled)),
    { discard: true }
  );

it.effect.prop(
  "a reader that finds the mailbox unavailable or slow, or a lease held by another session that later lapses, is Live within a bounded retry of the mailbox returning with no claim, in a successor or not",
  [Arbitrary.schema(Case)],
  ([scenario]) =>
    Effect.gen(function* outage() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const session = "me";
      const begin = yield* Clock.currentTimeMillis;

      const server: Server = {
        holder: scenario.holderIsSelf ? session : "other",
        listed: false,
        outageFrom: begin + scenario.outageStartMs,
        outageUntil: begin + scenario.outageStartMs + scenario.outageMs,
        serial: 1,
        until: begin + scenario.holderMs,
      };

      const readyAt = Math.max(server.until, server.outageUntil);

      const live = Effect.gen(function* observe() {
        const { reader } = yield* (yield* RatKing).status;

        return (
          ReaderState.$is("Live")(reader) &&
          Date.parse(reader.expiresAt) > server.outageUntil
        );
      });

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            session,
            successor: scenario.successor,
          },
          () => Effect.void
        );

        yield* advance(Math.max(0, readyAt - begin));

        let elapsed = 0;

        while (elapsed < RETRY_BOUND_MS && !(yield* live)) {
          yield* advance(1000);
          elapsed += 1000;
        }

        expect(yield* live).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            harness(state, serve(server, session, scenario.slow)),
            quietSocket
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 }, timeout: 600_000 }
);

it.effect.prop(
  "a planned mid-lease outage of 20–150 seconds transitions through retrying to live without a takeover or synthetic crashed turn",
  {
    duration: Schema.Int.check(
      Schema.isBetween({ maximum: 150_000, minimum: 20_000 })
    ),
    slow: Schema.Boolean,
    start: Schema.Int.check(
      Schema.isBetween({ maximum: 150_000, minimum: 140_000 })
    ),
  },
  ({ duration, start, slow }) =>
    Effect.gen(function* plannedStop() {
      const state = "/planned-outage-fixture";
      const begin = yield* Clock.currentTimeMillis;
      const transitions: string[] = [];
      const firstLive = yield* Deferred.make<boolean>();
      let leaseUntil = begin + TTL_MS;

      const server: Server = {
        holder: "me",
        listed: false,
        outageFrom: begin + start,
        outageUntil: begin + start + duration,
        serial: 0,
        until: begin,
      };

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(
          {
            alive: () => true,
            env: Option.some("tester"),
            onState: (reader) => {
              transitions.push(reader._tag);

              if (ReaderState.$is("Live")(reader)) {
                leaseUntil = Date.parse(reader.expiresAt);

                if (server.listed) {
                  Deferred.doneUnsafe(firstLive, Effect.succeed(true));
                }
              }
            },
            owner: Option.some("desk"),
            pane: Option.none(),
            pid: 1,
            session: "me",
          },
          () => Effect.void
        );

        yield* Deferred.await(firstLive);
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(crypto.subtle, "sign")
              .mockResolvedValue(new ArrayBuffer(64))
          ),
          (signing) =>
            Effect.sync(() => {
              signing.mockRestore();
            })
        );

        const invariant = Effect.gen(function* invariant() {
          const { reader } = yield* ratking.status;
          const now = yield* Clock.currentTimeMillis;

          const beat = ReaderHeartbeat.make({
            acquisitionSince: DateTime.makeUnsafe(begin),
            generation: server.serial,
            lastConsumeOk: DateTime.makeUnsafe(begin),
            lastError: null,
            leaseHeldSince: null,
            leaseTtlMs: TTL_MS,
            leaseUntil: DateTime.makeUnsafe(leaseUntil),
            name: "tester",
            owner: "desk",
            pid: 1,
            session: "me",
            startedAt: DateTime.makeUnsafe(begin),
            state: reader._tag,
            updatedAt: DateTime.makeUnsafe(now),
          });

          expect(
            crashedReader(beat, now, {
              backup: { end: server.outageUntil, start: server.outageFrom },
            })
          ).toBeUndefined();
          expect(transitions).not.toContain("SendOnly");
          expect(transitions).not.toContain("Refused");
          expect(server.holder).toBe("me");
          expect(server.serial).toBeLessThanOrEqual(2);
        });

        yield* runEffectModel(
          () => ({ model: { phase: 0 }, real: {} }),
          [start, duration, 160_000].map((millis, phase) => ({
            check: (model: Readonly<{ phase: number }>) =>
              model.phase === phase,
            run: (model: { phase: number }) =>
              advance(millis, Effect.yieldNow).pipe(
                Effect.andThen(invariant),
                Effect.tap(() =>
                  Effect.sync(() => {
                    model.phase += 1;
                  })
                )
              ),
            toString: () => ["live", "outage", "recovered"][phase] ?? "step",
          }))
        );

        expect(ReaderState.$is("Live")((yield* ratking.status).reader)).toBe(
          true
        );
        expect(transitions).toContain("Retrying");
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            harness(state, serve(server, "me", slow), [], {}, memoryFiles()),
            quietSocket
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
