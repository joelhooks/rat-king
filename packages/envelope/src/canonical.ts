import { decode, encode } from "@ipld/dag-cbor";
import type * as Defs from "@rat-king/lexicon/defs";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Effect, Schema } from "effect";

import { EnvelopeFailure } from "./failure.ts";

export const suite = Object.freeze({ aeadId: 1, kdfId: 1, kemId: 16 });

export const signatureDomain = new TextEncoder().encode(
  "sh.mschf.ratking.signature.v1\0"
);

const aadDomain = new TextEncoder().encode("sh.mschf.ratking.aad.v1\0");

export const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

export const concatenate = (...parts: readonly Uint8Array[]) => {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  );

  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
};

export const canonical = (value: Runtime.LexValue) => encode(value);

export const canonicalDecode = Effect.fn("Envelope.canonicalDecode")(
  function* canonicalDecode(bytes: Uint8Array) {
    const value = yield* Effect.try({
      catch: () => new EnvelopeFailure({ reason: "Invalid CBOR" }),
      try: () => decode(bytes),
    });

    const parsed = yield* Schema.decodeUnknownEffect(
      Schema.toType(Runtime.Data)
    )(value).pipe(
      Effect.mapError(
        () => new EnvelopeFailure({ reason: "Invalid data model" })
      )
    );

    if (!equalBytes(bytes, canonical(parsed))) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Noncanonical CBOR" })
      );
    }

    return parsed;
  }
);

export const signingBytes = (payload: Defs.SigningPayloadValue) =>
  concatenate(signatureDomain, canonical(payload));

export const aadBytes = (
  envelope: Pick<
    Defs.EncryptedEnvelopeValue,
    "version" | "suite" | "enc" | "aad"
  >
) =>
  concatenate(
    aadDomain,
    canonical({
      aad: envelope.aad,
      enc: envelope.enc,
      suite: envelope.suite,
      version: envelope.version,
    })
  );

export const supported = (
  envelope: Pick<Defs.EncryptedEnvelopeValue, "version" | "suite">
) =>
  envelope.version === 1 &&
  equalBytes(canonical(envelope.suite), canonical(suite));
