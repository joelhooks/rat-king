import { it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { expect } from "vitest";

import { readFrontDeskInput } from "../../../../stacks/nest/front-desk-command.ts";

it.effect.prop(
  "front desk stdin accepts exactly one bounded JSON payload with a quiet decision",
  [Schema.Boolean, Schema.Int],
  ([quiet, nonce]) =>
    Effect.gen(function* check() {
      const payload = {
        body: `body ${nonce} 🐀`,
        id: `${nonce}`,
        quiet,
        summary: "sample",
      };

      const bytes = new TextEncoder().encode(JSON.stringify(payload));

      expect(
        yield* readFrontDeskInput(
          Stream.make(bytes.slice(0, 12), bytes.slice(12))
        )
      ).toEqual(payload);

      expect(
        yield* readFrontDeskInput(
          Stream.make(bytes, new Uint8Array(65_536))
        ).pipe(Effect.isFailure)
      ).toBe(true);
    })
);
