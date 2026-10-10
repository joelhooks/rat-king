import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { decodePayload, encodePayload, Payload } from "../src/payload.ts";

it.effect.prop(
  "a message on the wire carries only from, body, kind and replyTo, even when the caller holds a session id",
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
        keys.every((key) => ["body", "from", "kind", "replyTo"].includes(key))
      ).toBe(true);

      expect(yield* decodePayload(json)).toEqual(Option.some(payload));
    })
);
