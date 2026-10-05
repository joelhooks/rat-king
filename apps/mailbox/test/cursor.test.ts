import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { decodeCursor, encodeCursor } from "../src/cursor.ts";

it.effect(
  "cursors authenticate snapshots and explicitly reject version, recipient, future and fingerprint mismatches",
  () =>
    Effect.gen(function* verifyContract() {
      const secret = crypto.getRandomValues(new Uint8Array(32));

      const cursor = {
        fingerprint: "query",
        lastSeq: 2,
        recipient: "did:web:recipient.example",
        throughSeq: 5,
        version: 1,
      };

      const token = yield* encodeCursor(cursor, secret);

      const request = {
        afterSeq: 0,
        fingerprint: cursor.fingerprint,
        recipient: cursor.recipient,
        secret,
        token,
        watermark: 5,
      };

      expect(yield* decodeCursor(request)).toEqual(cursor);

      for (const invalid of [
        { ...cursor, version: 2 },
        { ...cursor, recipient: "did:web:wrong.example" },
        { ...cursor, throughSeq: 6 },
        { ...cursor, lastSeq: 6 },
        { ...cursor, fingerprint: "other" },
        { ...cursor, lastSeq: -1 },
      ]) {
        expect(
          (yield* decodeCursor({
            ...request,
            token: yield* encodeCursor(invalid, secret),
          }).pipe(Effect.exit))._tag
        ).toBe("Failure");
      }

      const [part = "", signature = ""] = token.split(".");
      expect(
        (yield* decodeCursor({
          ...request,
          token: `${part}.${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`,
        }).pipe(Effect.exit))._tag
      ).toBe("Failure");
      expect(
        (yield* decodeCursor({ ...request, afterSeq: 3 }).pipe(Effect.exit))
          ._tag
      ).toBe("Failure");
    })
);
