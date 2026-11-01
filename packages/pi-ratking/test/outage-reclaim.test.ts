import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

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
  outageFrom: number;
  outageUntil: number;
  serial: number;
  until: number;
}

const settle = TestClock.withLive(Effect.sleep("5 millis"));

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

        server.until = now + TTL_MS;

        return respond(request, { lease: lease(server, input.did) });
      }

      if (nsid.endsWith(".resolveLease")) {
        const did = new URL(request.url).searchParams.get("did") ?? "";

        return held
          ? respond(request, { lease: lease(server, did) })
          : respond(request, { error: "LeaseNotFound" }, 404);
      }

      return yield* mailbox.http.execute(request);
    })
  );
};

const advance = (millis: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(millis / 1000) }),
    () => TestClock.adjust(1000).pipe(Effect.andThen(settle)),
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
