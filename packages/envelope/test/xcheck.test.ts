import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import {
  aadBytes,
  canonicalDecode,
  info,
  open,
  reviewStatus,
  signingBytes,
} from "../src/envelope.ts";
import goWire from "./vectors/xcheck/go.json" with { type: "json" };
import receipt from "./vectors/xcheck/receipt.json" with { type: "json" };
import tsWire from "./vectors/xcheck/ts.json" with { type: "json" };
import {
  Fixture,
  importKeys,
  payloadArbitrary,
  requestFor,
} from "./xcheck-support.ts";

const fixture = Schema.decodeUnknownSync(Fixture)(goWire);

const tsRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      accepted: Schema.Boolean,
      envelope: Defs.EncryptedEnvelope,
      payload: Defs.SigningPayload,
    })
  )
)(tsWire);

const vectorFor = (payload: Defs.SigningPayloadValue) => {
  const bytes = signingBytes(payload);

  const vector = fixture.vectors.find((sample) =>
    Buffer.from(sample.signingBytes).equals(Buffer.from(bytes))
  );

  if (!vector) {
    throw new Error("Schema-derived payload missing independent Go vector");
  }

  return vector;
};

it.effect.prop(
  "independent Go seals open in TS with identical signing bytes, AAD and info",
  { wire: payloadArbitrary },
  ({ wire }) =>
    Effect.gen(function* goToTs() {
      const payload = yield* Schema.decodeUnknownEffect(Defs.SigningPayload)(
        wire
      );

      const vector = vectorFor(payload);
      const keys = yield* importKeys(fixture);
      expect(signingBytes(payload)).toEqual(vector.signingBytes);
      expect(aadBytes(vector.envelope)).toEqual(vector.aadBytes);
      expect(info).toEqual(fixture.info);
      expect(yield* open(requestFor(vector.envelope, keys))).toEqual(payload);
      expect(reviewStatus).toBe("unreviewed");
    }),
  { arbitrary: { runs: 40, seed: 9180 } }
);

it.effect.prop(
  "Go and TS reject malformed and noncanonical signed plaintext identically",
  { wire: payloadArbitrary },
  ({ wire }) =>
    Effect.gen(function* rejection() {
      const payload = yield* Schema.decodeUnknownEffect(Defs.SigningPayload)(
        wire
      );

      const vector = vectorFor(payload);
      const keys = yield* importKeys(fixture);

      for (const sample of vector.reject) {
        expect(
          (yield* open(requestFor(sample.envelope, keys)).pipe(Effect.exit))
            ._tag,
          sample.name
        ).toBe("Failure");
      }

      for (const sample of fixture.canonicalReject) {
        expect(
          (yield* canonicalDecode(sample.bytes).pipe(Effect.exit))._tag,
          sample.name
        ).toBe("Failure");
        expect(sample.accepted).toBe(false);
      }
    }),
  { arbitrary: { runs: 20, seed: 9181 } }
);

it.effect.prop(
  "TS seal corpus verified by Go has the same accepted/rejected outcomes in TS",
  { wire: payloadArbitrary },
  ({ wire }) =>
    Effect.gen(function* tsToGo() {
      const payload = yield* Schema.decodeUnknownEffect(Defs.SigningPayload)(
        wire
      );

      const keys = yield* importKeys(fixture);

      const rows = tsRows.filter((row) =>
        Buffer.from(signingBytes(row.payload)).equals(
          Buffer.from(signingBytes(payload))
        )
      );

      expect(rows.length).toBe(vectorFor(payload).reject.length + 5);
      expect(receipt.goVerified).toBe(tsRows.length);

      for (const row of rows) {
        const exit = yield* open(requestFor(row.envelope, keys)).pipe(
          Effect.exit
        );

        if (Exit.isSuccess(exit)) {
          expect(row.accepted).toBe(true);
          expect(exit.value).toEqual(payload);
        } else {
          expect(row.accepted).toBe(false);
        }
      }
    }),
  { arbitrary: { runs: 20, seed: 9182 } }
);
