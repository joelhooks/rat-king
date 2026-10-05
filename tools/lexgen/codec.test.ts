import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { Bytes, DataMap, Link } from "../../packages/lexicon/src/runtime.ts";

it.effect(
  "rejects malformed byte and link wrappers instead of stripping wrapper fields",
  () =>
    Effect.gen(function* wrappers() {
      for (const value of [
        { $bytes: "AQID", future: "do not strip" },
        { $link: "not-a-cid" },
      ]) {
        expect(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(DataMap)({ nested: value }).pipe(
              Effect.result
            )
          )
        ).toBe(true);
      }

      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Bytes)({
            $bytes: "AQID",
            future: "do not strip",
          }).pipe(Effect.result)
        )
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Link)({ $link: "not-a-cid" }).pipe(
            Effect.result
          )
        )
      ).toBe(true);
    })
);
