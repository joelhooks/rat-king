import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { decodePayload, encodePayload, Payload } from "../src/payload.ts";

it.effect.prop(
  "a message on the wire carries signed message and thread fields, never caller session ids",
  [Arbitrary.schema(Payload), Arbitrary.schema(Schema.String)],
  ([payload, session]) =>
    Effect.gen(function* wire() {
      const leaky = { ...payload, session, sessionId: session };
      const json = yield* encodePayload(leaky);

      const keys = Object.keys(
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
        )(json)
      );

      expect(
        keys.every((key) =>
          [
            "body",
            "cc",
            "from",
            "kind",
            "label",
            "replyTo",
            "summary",
            "thread",
            "to",
          ].includes(key)
        )
      ).toBe(true);

      expect(yield* decodePayload(json)).toEqual(Option.some(payload));
    })
);
