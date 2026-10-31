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

const LIVE_BOUND_MS = 2 * TTL_MS;

const Case = Schema.Struct({
  outageMs: Schema.Int.check(
    Schema.isBetween({ maximum: 420_000, minimum: 20_000 })
  ),
  outageStartMs: Schema.Int.check(
    Schema.isBetween({ maximum: 200_000, minimum: 0 })
  ),
  renewFault: Schema.Literals(["none", "LeaseRenewalFailed", "LeaseMismatch"]),
  successor: Schema.Boolean,
});

interface Server {
  faultPending: boolean;
  leaseId: string;
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

const serve = (
  server: Server,
  session: string,
  fault: "none" | "LeaseRenewalFailed" | "LeaseMismatch"
) => {
  const mailbox = fakeMailbox("accept");

  const grant = (
    request: Parameters<typeof respond>[0],
    input: { readonly did: string },
    now: number,
    generation: number
  ) => {
    server.until = now + TTL_MS;

    return respond(request, {
      lease: {
        ...input,
        expiresAt: stamp(server.until),
        generation,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: session,
        },
        leaseId: server.leaseId,
      },
    });
  };

  return HttpClient.make((request) =>
    Effect.gen(function* handle() {
      const nsid = new URL(request.url).pathname;
      const now = yield* Clock.currentTimeMillis;
      const live = server.until > now;

      if (now >= server.outageFrom && now < server.outageUntil) {
        return respond(request, { error: "MailboxUnavailable" }, 503);
      }

      if (nsid.endsWith(".acquireLease")) {
        const input = yield* decode(Acquire.Input, request);

        if (live) {
          return respond(request, { error: "LeaseHeld" }, 409);
        }

        server.serial += 1;
        server.leaseId = `3mxcx45mn7s${String(server.serial).padStart(2, "a")}`;

        return grant(request, input, now, server.serial);
      }

      if (nsid.endsWith(".renewLease")) {
        const input = yield* decode(Renew.Input, request);

        if (server.faultPending && now >= server.outageUntil) {
          server.faultPending = false;

          if (fault !== "none") {
            return respond(request, { error: fault }, 409);
          }
        }

        return grant(request, input, now, server.serial);
      }

      if (nsid.endsWith(".resolveLease")) {
        const did = new URL(request.url).searchParams.get("did") ?? "";

        if (!live) {
          return respond(request, { error: "LeaseNotFound" }, 404);
        }

        return respond(request, {
          lease: {
            did,
            expiresAt: stamp(server.until),
            generation: server.serial,
            harness: {
              $type: "sh.mschf.ratking.runtime.lease#pi",
              sessionId: session,
            },
            leaseId: server.leaseId,
          },
        });
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
  "a Live reader whose mailbox goes unavailable and returns to a lease still held by its own earlier session, with one failed renewal, is Live again within two lease TTLs with no claim, in a successor or not",
  [Arbitrary.schema(Case)],
  ([scenario]) =>
    Effect.gen(function* cutover() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const session = "me";

      const server: Server = {
        faultPending: true,
        leaseId: "3mxcx45mn7sxx",
        outageFrom: Number.MAX_SAFE_INTEGER,
        outageUntil: Number.MAX_SAFE_INTEGER,
        serial: 0,
        until: 0,
      };

      const live = Effect.gen(function* observe() {
        const { reader } = yield* (yield* RatKing).status;

        return ReaderState.$is("Live")(reader);
      });

      const renewed = Effect.gen(function* observe() {
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

        yield* advance(1_000_000);
        expect(yield* live).toBe(true);

        const begin = yield* Clock.currentTimeMillis;

        server.outageFrom = begin + scenario.outageStartMs;
        server.outageUntil = server.outageFrom + scenario.outageMs;

        yield* advance(scenario.outageStartMs + scenario.outageMs);

        let elapsed = 0;

        while (elapsed < LIVE_BOUND_MS && !(yield* renewed)) {
          yield* advance(1000);
          elapsed += 1000;
        }

        expect(yield* renewed).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            harness(state, serve(server, session, scenario.renewFault)),
            quietSocket
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 }, timeout: 300_000 }
);
