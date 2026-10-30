import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
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

const UPTIME_MS = 1_000_000;

const Holder = Schema.Literals(["own", "unidentified", "foreign"]);

const Case = Schema.Struct({
  holder: Holder,
  successor: Schema.Boolean,
});

interface Server {
  acquires: number;
  holder: typeof Holder.Type | undefined;
  leaseId: string;
  until: number;
}

const settle = TestClock.withLive(Effect.sleep("5 millis"));

const stamp = (until: number) => DateTime.formatIso(DateTime.makeUnsafe(until));

const serve = (server: Server, session: string) => {
  const mailbox = fakeMailbox("accept");

  const http = HttpClient.make((request) =>
    Effect.gen(function* handle() {
      const nsid = new URL(request.url).pathname;
      const now = yield* Clock.currentTimeMillis;
      const live = server.holder !== undefined && server.until > now;

      if (
        nsid.endsWith(".acquireLease") &&
        Predicate.isTagged(request.body, "Uint8Array")
      ) {
        server.acquires += 1;

        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Acquire.Input)
        )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

        if (server.holder === undefined && server.until === 0) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "MailboxUnavailable" }, { status: 503 })
          );
        }

        if (live && input.leaseId !== server.leaseId) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "LeaseHeld" }, { status: 409 })
          );
        }

        server.holder = "own";
        server.leaseId = "3mxcx45mn7sey";
        server.until = now + TTL_MS;

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            lease: {
              ...input,
              expiresAt: stamp(server.until),
              generation: 9,
              leaseId: server.leaseId,
            },
          })
        );
      }

      if (nsid.endsWith(".resolveLease")) {
        const did = new URL(request.url).searchParams.get("did") ?? "";

        if (!live) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "LeaseNotFound" }, { status: 404 })
          );
        }

        const identities = {
          foreign: { sessionId: "taker" },
          own: { sessionId: session },
          unidentified: { paneId: "pane-1" },
        };

        const identity = identities[server.holder ?? "foreign"];

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            lease: {
              did,
              expiresAt: stamp(server.until),
              generation: 8,
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                ...identity,
              },
              leaseId: server.leaseId,
            },
          })
        );
      }

      return yield* mailbox.http.execute(request);
    })
  );

  return http;
};

const advance = <R = never>(
  millis: number,
  observe: Effect.Effect<void, never, R> = Effect.void
) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(millis / 1000) }),
    () =>
      TestClock.adjust(1000).pipe(
        Effect.andThen(settle),
        Effect.andThen(observe)
      ),
    { discard: true }
  );

it.effect.prop(
  "a reader whose own earlier lease still holds the name, or whose holder is unidentified, ends Live once the TTL passes, in a successor or not; a live foreign session parks it send-only until its lease lapses, with no claim",
  [Arbitrary.schema(Case)],
  ([scenario]) =>
    Effect.gen(function* recovery() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const session = "me";

      const server: Server = {
        acquires: 0,
        holder: undefined,
        leaseId: "3mxcx45mn7sex",
        until: 0,
      };

      const live = Effect.gen(function* observe() {
        const { reader } = yield* (yield* RatKing).status;

        return ReaderState.$is("Live")(reader);
      });

      const sendOnly = Effect.gen(function* observe() {
        const { reader } = yield* (yield* RatKing).status;

        return ReaderState.$is("SendOnly")(reader);
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

        yield* advance(UPTIME_MS);
        expect(yield* live).toBe(false);

        server.holder = scenario.holder;
        server.until = (yield* Clock.currentTimeMillis) + TTL_MS;

        const foreignUntil = server.until;

        let parked = false;

        let tookLive = false;

        const watch = Effect.gen(function* sample() {
          const now = yield* Clock.currentTimeMillis;

          parked ||= yield* sendOnly;
          tookLive ||=
            scenario.holder === "foreign" &&
            now < foreignUntil &&
            (yield* live);
        });

        yield* advance(TTL_MS + 60_000, watch);

        const settled = live;

        for (let step = 0; step < 600 && !(yield* settled); step += 1) {
          yield* advance(1000, watch);
        }

        expect(yield* settled).toBe(true);

        if (scenario.holder === "foreign") {
          expect(parked).toBe(true);
        } else {
          expect(parked).toBe(false);
        }

        expect(tookLive).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            harness(state, serve(server, session)),
            quietSocket
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 120_000 }
);
