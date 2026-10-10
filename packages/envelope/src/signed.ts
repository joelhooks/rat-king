import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";

import {
  canonical,
  canonicalDecode,
  equalBytes,
  plaintext,
  plaintextEnc,
  signatureDomain,
} from "./canonical.ts";
import { verify } from "./es256.ts";
import { EnvelopeFailure } from "./failure.ts";

export type ResolveSigningKey = (
  senderDid: string,
  keyId: string
) => Effect.Effect<CryptoKey, EnvelopeFailure>;

const decodeSigned = Effect.fn("Envelope.decodeSigned")(function* decodeSigned(
  signedBytes: Uint8Array
) {
  const signed = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SignedMessage)
  )(yield* canonicalDecode(signedBytes));

  const bytes = signed.canonicalSigningBytes;

  if (!equalBytes(bytes.subarray(0, signatureDomain.length), signatureDomain)) {
    return yield* Effect.fail(
      new EnvelopeFailure({ reason: "Wrong signature domain" })
    );
  }

  const payload = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SigningPayload)
  )(yield* canonicalDecode(bytes.subarray(signatureDomain.length)));

  return { bytes, payload, signed };
});

export const verifySigned = Effect.fn("Envelope.verifySigned")(
  function* verifySigned(
    envelope: Defs.EncryptedEnvelopeValue,
    signedBytes: Uint8Array,
    resolveSigningKey: ResolveSigningKey
  ) {
    const { bytes, payload, signed } = yield* decodeSigned(signedBytes);

    if (
      !equalBytes(
        canonical({
          aad: payload.aad,
          suite: payload.suite,
          version: payload.version,
        }),
        canonical({
          aad: envelope.aad,
          suite: envelope.suite,
          version: envelope.version,
        })
      )
    ) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Inner metadata mismatch" })
      );
    }

    const app = signed.appSignature;

    if (
      app.algorithm !== "ES256" ||
      !app.keyId.startsWith(`${envelope.aad.senderDid}#`)
    ) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Unauthorized signing key" })
      );
    }

    const key = yield* resolveSigningKey(envelope.aad.senderDid, app.keyId);

    if (!(yield* verify(key, bytes, app.signature))) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Invalid application signature" })
      );
    }

    return payload;
  }
);

export const openPlaintext = Effect.fn("Envelope.openPlaintext")(
  function* openPlaintext(
    envelope: Defs.EncryptedEnvelopeValue,
    resolveSigningKey: ResolveSigningKey
  ) {
    if (!plaintext(envelope) || !equalBytes(envelope.enc, plaintextEnc())) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Not a signed plaintext envelope" })
      );
    }

    return yield* verifySigned(
      envelope,
      envelope.ciphertext,
      resolveSigningKey
    );
  }
);

export const plaintextBody = Effect.fn("Envelope.plaintextBody")(
  function* plaintextBody(envelope: Defs.EncryptedEnvelopeValue) {
    if (!plaintext(envelope)) {
      return yield* Effect.fail(
        new EnvelopeFailure({ reason: "Not a signed plaintext envelope" })
      );
    }

    const { payload } = yield* decodeSigned(envelope.ciphertext);

    return yield* Effect.try({
      catch: () => new EnvelopeFailure({ reason: "Invalid UTF-8 body" }),
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          payload.body
        ),
    });
  }
);
