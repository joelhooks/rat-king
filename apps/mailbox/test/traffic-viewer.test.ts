/* oxlint-disable typescript/promise-function-async -- The synthetic fetch and fast-check command adapter return native promises. */
import { it } from "@effect/vitest";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import * as History from "@rat-king/lexicon/mailbox.listTraffic";
import * as Tail from "@rat-king/lexicon/mailbox.subscribeTraffic";
import { Claims, unbase64url } from "@rat-king/mailbox-client/auth";
import { Arbitrary, Deferred, Effect, Schema, Stream } from "effect";
import type { Socket } from "effect/socket";
import * as fc from "fast-check";
import { expect } from "vitest";

import type { Sql } from "../src/sqlite.ts";
import {
  appendTraffic,
  listTraffic,
  trafficTables,
  TrafficEntry,
} from "../src/traffic-store.ts";
import { trafficSource } from "../viewer/client.ts";
import { emptySnapshot, Feed, feedLayer, WINDOW } from "../viewer/feed.ts";
import { route } from "../viewer/http.ts";
import { content } from "../viewer/page.ts";
import { projectTraffic } from "../viewer/view.ts";
import { TestFailure } from "./celld.ts";
import { testStore } from "./helpers.ts";

const login = "synthetic-reader";

const sender = "did:web:sender.example.invalid";

const recipient = "did:web:recipient.example.invalid";

const peer = "did:web:peer.example.invalid";

const askId = "3jzfcijpj2z2a";

const replyId = "3jzfcijpj2z2b";

const payload = "<script>opaque & untrusted</script>";

const liveSnapshot = () => ({ ...emptySnapshot, status: "live" as const });

it.prop(
  "every route requires exactly one allowlisted login and sets privacy headers",
  [
    Arbitrary.schema(
      Schema.Literals([
        "/",
        "/healthz",
        "/snapshot",
        "/viewer.js",
        "/viewer.css",
        "/missing",
      ])
    ),
    Arbitrary.schema(Schema.String),
  ],
  ([target, wrong]) => {
    fc.pre(wrong !== login);

    const get = (loginHeaders?: readonly string[]) =>
      route({
        loginHeaders,
        logins: new Set([login]),
        method: "GET",
        snapshot: liveSnapshot,
        target,
      });

    const admitted = get([login]);
    const refusals = [get(), get([wrong]), get([login, wrong])];
    expect(admitted.status).toBe(target === "/missing" ? 404 : 200);

    for (const refusal of refusals) {
      expect(refusal.status).toBe(403);
      expect(refusal.body).toBe("Forbidden\n");
    }

    for (const response of [admitted, ...refusals]) {
      expect(response.headers).toMatchObject({
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      });
    }
  }
);

const syntheticTid = (seq: number) => {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";

  return `3jzfcijpj2${alphabet.charAt(Math.floor(seq / 32))}${alphabet.charAt(seq % 32)}a`;
};

it.effect.prop(
  "a live notice reads only the bounded history window; the next notice resumes at its checkpoint",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 650, minimum: 501 }))
    ),
  ],
  ([initial]) =>
    Effect.gen(function* historyThenTail() {
      const { sql } = yield* testStore;
      const ready = yield* Deferred.make<boolean>();
      trafficTables(sql);
      const through = initial + 3;

      const rows = Array.from({ length: through }, (_, index) => {
        const seq = index + 1;

        return Schema.decodeSync(TrafficEntry)({
          ciphertextSize: 29,
          messageId: syntheticTid(seq),
          recipientDid: recipient,
          recipientSeq: seq,
          senderDid: sender,
          seq,
          state: "accepted",
          time: "2026-10-06T00:00:00Z",
        });
      });

      appendTraffic(sql, rows);
      const cursors: number[] = [];

      const source = {
        list: (cursor: number) =>
          Effect.sync(() => {
            cursors.push(cursor);

            return listTraffic(sql, { cursor: String(cursor), limit: 100 });
          }),
        notices: Stream.make(initial, through).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(ready, true).pipe(Effect.andThen(Effect.never))
            )
          )
        ),
      };

      yield* Effect.gen(function* observe() {
        const feed = yield* Feed;
        yield* Effect.forkScoped(feed.run);
        yield* Deferred.await(ready);
        const snapshot = yield* feed.read;
        expect(snapshot.status).toBe("live");
        expect(snapshot.watermark).toBe(through);
        expect(cursors).toEqual(
          Array.from(
            { length: 6 },
            (_, index) => initial - WINDOW + 100 * index
          )
        );
        expect(
          snapshot.projects
            .flatMap(({ threads }) => threads)
            .map(({ key }) => key)
        ).toEqual(
          Array.from({ length: WINDOW }, (_, index) => through - index)
        );
      }).pipe(Effect.provide(feedLayer(source)));
    }),
  { arbitrary: { runs: 10 } }
);

type SocketEventName = "open" | "message" | "error" | "close";

const fakeSocket = (
  send: (data: string | Uint8Array<ArrayBuffer>) => void
): Socket.WebSocketLike => {
  const handlers = new Map<
    SocketEventName,
    (event: Socket.WebSocketEvent) => void
  >();

  return {
    addEventListener: (type, listener) => {
      handlers.set(type, listener);
    },
    close: () => {
      handlers.clear();
    },
    readyState: 1,
    removeEventListener: (type) => {
      handlers.delete(type);
    },
    send: (data) => {
      send(data);
      handlers.get("message")?.({
        data: JSON.stringify({ $type: `${Tail.Method.nsid}#notice`, seq: 7 }),
      });
    },
  };
};

const AuthFrame = Schema.fromJsonString(
  Schema.Struct({ $type: Schema.String, token: Schema.String })
);

const decodeClaims = Schema.decodeUnknownSync(Schema.fromJsonString(Claims));

const claimsOf = (jwt: string) =>
  decodeClaims(new TextDecoder().decode(unbase64url(jwt.split(".")[1] ?? "")));

it.effect.prop(
  "history and tail are the only outbound NSIDs, including inside auth claims",
  [Arbitrary.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))],
  ([cursor]) =>
    Effect.gen(function* wire() {
      const generated = yield* cryptoOperation(() =>
        crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign", "verify"]
        )
      );

      const keys = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ privateKey: Schema.instanceOf(CryptoKey) })
      )(generated);

      const endpoint = new URL("https://mailbox.example.invalid");
      const did = "did:web:observer.example.invalid";
      const audience = "did:web:mailbox.example.invalid#mailbox";

      const observed: {
        readonly action: string;
        readonly url: string;
        readonly token: string;
      }[] = [];

      const source = trafficSource(
        { audience, did, endpoint, key: keys.privateKey },
        {
          connect: (url) =>
            fakeSocket((data) => {
              const frame = Schema.decodeUnknownSync(AuthFrame)(data);
              observed.push({ action: frame.$type, token: frame.token, url });
            }),
          fetch: (url, init) => {
            const authorization =
              new Headers(init?.headers).get("authorization") ?? "";

            expect(init?.redirect).toBe("error");
            observed.push({
              action: init?.method ?? "",
              token: authorization.slice("Bearer ".length),
              url: url.href,
            });

            return Promise.resolve(
              Response.json({ cursor: String(cursor), events: [] })
            );
          },
        }
      );

      yield* source.list(cursor);

      const notices = yield* source.notices.pipe(
        Stream.take(1),
        Stream.runCollect
      );

      expect(notices).toEqual([7]);
      expect(Object.keys(source).toSorted()).toEqual(["list", "notices"]);
      expect(
        observed.map(({ action, url, token }) => ({
          action,
          claims: claimsOf(token),
          url,
        }))
      ).toMatchObject([
        {
          action: "GET",
          claims: {
            aud: audience,
            iss: did,
            lxm: "sh.mschf.ratking.mailbox.listTraffic",
          },
          url: `${endpoint.origin}${History.Method.path}?cursor=${cursor}&limit=100`,
        },
        {
          action: "sh.mschf.ratking.mailbox.subscribeTraffic#auth",
          claims: {
            aud: audience,
            iss: did,
            lxm: "sh.mschf.ratking.mailbox.subscribeTraffic",
          },
          url: `wss://${endpoint.host}${Tail.Method.path}`,
        },
      ]);
    })
);

const operations = Schema.Array(
  Schema.Literals(["ask", "receipt", "reply", "sealed"])
).check(Schema.isMaxLength(24));

it.effect.prop(
  "the thread projection follows visible asks and replies across receipt and sealed traffic",
  [Arbitrary.schema(operations)],
  ([steps]) =>
    Effect.gen(function* projectionModel() {
      const { sql } = yield* testStore;
      trafficTables(sql);

      const model = {
        asked: false,
        replied: false,
        sealed: false,
        step: 0,
      };

      const commands: fc.AsyncCommand<typeof model, Sql>[] = steps.map(
        (operation) => ({
          check: (state) => {
            switch (operation) {
              case "ask": {
                return !state.asked;
              }

              case "receipt": {
                return state.asked;
              }

              case "reply": {
                return state.asked && !state.replied;
              }

              case "sealed": {
                return !state.sealed;
              }

              default: {
                return false;
              }
            }
          },
          run: (state, database) => {
            state.step += 1;

            const askBody = JSON.stringify({
              body: payload,
              cc: ["synthetic/copy"],
              from: "synthetic/reader",
              kind: "ask",
              thread: askId,
              to: "synthetic/writer",
            });

            const replyBody = JSON.stringify({
              body: "Done",
              from: "synthetic/writer",
              kind: "reply",
              quiet: true,
              reply: { parent: askId, root: askId },
              to: "synthetic/reader",
            });

            const payloadFields =
              operation === "sealed"
                ? {}
                : { body: operation === "reply" ? replyBody : askBody };

            const senders = {
              ask: sender,
              receipt: sender,
              reply: recipient,
              sealed: peer,
            };

            const entry = Schema.decodeSync(TrafficEntry)({
              ...payloadFields,
              ciphertextSize: 29,
              messageId: operation === "reply" ? replyId : askId,
              recipientDid: operation === "reply" ? sender : recipient,
              recipientSeq: state.step,
              senderDid: senders[operation],
              seq: state.step,
              state: operation === "receipt" ? "acked" : "accepted",
              time: "2026-10-06T00:00:00Z",
            });

            appendTraffic(database, [entry]);
            state.asked ||= operation === "ask";
            state.replied ||= operation === "reply";
            state.sealed ||= operation === "sealed";
            const { events } = listTraffic(database, { limit: 100 });
            const projects = projectTraffic(events);

            const thread = projects.find(({ name }) => name === "synthetic")
              ?.threads[0];

            expect(thread?.messages.length ?? 0).toBe(
              Number(state.asked) + Number(state.replied)
            );
            expect(thread?.asks.map(({ answered }) => answered) ?? []).toEqual(
              state.asked ? [state.replied] : []
            );

            const sealed = projects.find(({ name }) => name === "Unassigned")
              ?.threads[0]?.messages[0];

            expect(sealed?.mode).toBe(state.sealed ? "sealed" : undefined);

            if (sealed !== undefined) {
              expect(sealed).not.toHaveProperty("body");
            }

            const html = content(
              { ...emptySnapshot, projects },
              new URLSearchParams({ project: "synthetic" })
            );

            expect(html).not.toContain(payload);
            expect(
              html.includes(
                "&lt;script&gt;opaque &amp; untrusted&lt;/script&gt;"
              )
            ).toBe(state.asked);

            return Promise.resolve();
          },
          toString: () => operation,
        })
      );

      yield* Effect.tryPromise({
        catch: (cause) => new TestFailure({ message: String(cause) }),
        try: () => fc.asyncModelRun(() => ({ model, real: sql }), commands),
      });
    })
);
