import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { textDigest } from "../src/files.ts";
import { handleSlice } from "../src/slice-http.ts";
import { canonicalChunks, SliceSource } from "../src/slice-source.ts";
import type { Signature } from "../src/slice-source.ts";
import { sqliteSliceSource } from "../src/slice-sqlite.ts";
import { fixtureNow, makeSliceFixture } from "./slice-fixtures.ts";

const token = Redacted.make("invented-fixture-token-with-32-characters");

const authorization = `Bearer ${Redacted.value(token)}`;

const checkSliceText = (text: string) =>
  Effect.gen(function* fixture() {
    const path = yield* makeSliceFixture(text);
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readFile(path);
    yield* Effect.gen(function* checks() {
      const source = yield* SliceSource;
      const chunks = yield* source.slice("conversation-a", "first", "last");
      expect(chunks.map((chunk) => chunk.chunk_id)).toEqual(["first", "last"]);

      const response = yield* handleSlice(
        {
          authorization,
          method: "GET",
          url: "/slice?conversation=conversation-a&first=first&last=last",
        },
        token
      );

      expect(response.status).toBe(200);
      expect(response.body).toBe(
        JSON.stringify({
          chunks,
          conversation: "conversation-a",
          first: "first",
          last: "last",
          sha256: textDigest(canonicalChunks(chunks)),
        })
      );
      const stored = Buffer.from(text, "utf-8").toString("utf-8");
      expect(chunks[0]?.text).toBe(stored);
      const end = Math.min(Array.from(stored, (point) => point).length, 280);

      const quote = yield* handleSlice(
        {
          authorization,
          method: "GET",
          url: `/quote?chunk=first&start=0&end=${end}`,
        },
        token
      );

      const expected = Array.from(stored, (point) => point)
        .slice(0, end)
        .join("");

      expect(quote.body).toBe(
        JSON.stringify({
          chunk: "first",
          end,
          sha256: textDigest(expected),
          start: 0,
          text: expected,
        })
      );
    }).pipe(Effect.provide(sqliteSliceSource(path, 30)));
    expect(yield* fs.readFile(path)).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.prop(
  "slice spans runs, quote offsets use code points and digests cover exact canonical bytes",
  {
    text: Arbitrary.schema(Schema.String.check(Schema.isMaxLength(500))),
  },
  ({ text }) => checkSliceText(text)
);

it.effect("NUL bytes do not truncate slice text or code-point quotes", () =>
  Effect.gen(function* nulRegression() {
    yield* checkSliceText("\u0000");
    yield* checkSliceText("a\u0000😀b\u0000");
  })
);

it.effect.prop(
  "HTTP rejects unauthenticated, write, search, invalid ranges and oversize reads without leaking text",
  {
    mode: Arbitrary.schema(
      Schema.Literals([
        "auth",
        "write",
        "search",
        "reverse",
        "foreign",
        "missing",
        "offsets",
        "big",
        "duplicate",
        "bigquote",
      ])
    ),
  },
  ({ mode }) =>
    Effect.gen(function* refusal() {
      const path = yield* makeSliceFixture(
        mode === "big" ? "x".repeat(256 * 1024) : "private invented fixture 😀"
      );

      const cases = {
        auth: {
          authorization: undefined,
          method: "GET",
          status: 401,
          url: "/slice?conversation=conversation-a&first=first&last=last",
        },
        big: {
          authorization,
          method: "GET",
          status: 413,
          url: "/slice?conversation=conversation-a&first=first&last=last",
        },
        bigquote: {
          authorization,
          method: "GET",
          status: 400,
          url: "/quote?chunk=first&start=0&end=281",
        },
        duplicate: {
          authorization,
          method: "GET",
          status: 400,
          url: "/quote?chunk=first&chunk=other&start=0&end=1",
        },
        foreign: {
          authorization,
          method: "GET",
          status: 404,
          url: "/slice?conversation=conversation-a&first=first&last=other",
        },
        missing: {
          authorization,
          method: "GET",
          status: 404,
          url: "/quote?chunk=missing&start=0&end=1",
        },
        offsets: {
          authorization,
          method: "GET",
          status: 400,
          url: "/quote?chunk=first&start=0&end=100",
        },
        reverse: {
          authorization,
          method: "GET",
          status: 404,
          url: "/slice?conversation=conversation-a&first=last&last=first",
        },
        search: {
          authorization,
          method: "GET",
          status: 404,
          url: "/search?query=fixture",
        },
        write: { authorization, method: "DELETE", status: 405, url: "/slice" },
      };

      const request = cases[mode];

      const result = yield* handleSlice(request, token).pipe(
        Effect.provide(sqliteSliceSource(path, 30))
      );

      expect(result.status).toBe(request.status);
      expect(result.body).not.toContain("private invented");
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "idle cursor stops before an active conversation then releases the entire prefix once idle",
  () =>
    Effect.gen(function* cursor() {
      const path = yield* makeSliceFixture("fixture");
      yield* TestClock.setTime(fixtureNow);
      yield* Effect.gen(function* checks() {
        const source = yield* SliceSource;
        const first = yield* source.chunks(0, 2000, 1000);
        expect(first.items.map((item) => item.rowid)).toEqual([1]);
        expect(first.next).toBe(1);
        const blocked = yield* source.chunks(first.next, 2000, 1000);
        expect(blocked).toEqual({ items: [], next: 1 });
        yield* TestClock.adjust("501 millis");
        const resumed = yield* source.chunks(blocked.next, 2000, 1000);
        expect(resumed.items.map((item) => item.rowid)).toEqual([2, 3, 4, 5]);
        expect(resumed.next).toBe(5);
        expect(JSON.stringify(resumed)).not.toContain("active late");
      }).pipe(Effect.provide(sqliteSliceSource(path, 30)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.prop(
  "literal counts are case-sensitive, distinct per conversation, role-scoped and reject an old floor",
  {
    mode: Arbitrary.schema(
      Schema.Literals(["literal", "case", "role", "floor", "short"])
    ),
  },
  ({ mode }) =>
    Effect.gen(function* count() {
      const path = yield* makeSliceFixture("literal_100% MixedCase");
      yield* TestClock.setTime(fixtureNow);
      let literal = "literal_100% MixedCase";

      if (mode === "case") {
        literal = "literal_100% mixedcase";
      } else if (mode === "short") {
        literal = "tiny";
      }

      let signature: Signature = {
        literal,
        since_ms:
          fixtureNow - (mode === "floor" ? 31 * 86_400_000 : 86_400_000),
      };

      if (mode === "role") {
        signature = { ...signature, role: "user" };
      }

      const response = yield* handleSlice(
        {
          authorization,
          body: JSON.stringify({ signature }),
          method: "POST",
          url: "/count",
        },
        token
      ).pipe(Effect.provide(sqliteSliceSource(path, 30)));

      if (mode === "floor" || mode === "short") {
        expect(response.status).toBe(400);
        expect(response.body).toContain("floor");
      } else {
        let conversations = 2;

        if (mode === "case") {
          conversations = 0;
        } else if (mode === "role") {
          conversations = 1;
        }

        const day = "2027-01-15";
        expect(response.body).toBe(
          JSON.stringify({
            by_day: conversations === 0 ? [] : [{ conversations, day }],
            conversations,
          })
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
