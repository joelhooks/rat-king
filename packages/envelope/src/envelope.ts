/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Effect's lazy HPKE Promise adapters do not need redundant async wrappers. */
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";

import {
  aadBytes,
  canonical,
  canonicalDecode,
  equalBytes,
  signatureDomain,
  signingBytes,
  supported,
} from "./canonical.ts";
import { sign, verify } from "./es256.ts";
import { EnvelopeFailure } from "./failure.ts";
import { CompatibleP256Kem } from "./hpke-p256.ts";
import { cryptoOperation } from "./webcrypto.ts";

export const reviewStatus = "unreviewed";

export const hpke = new CipherSuite({
  aead: new Aes128Gcm(),
  kdf: new HkdfSha256(),
  kem: new CompatibleP256Kem(),
});

export const info = new TextEncoder().encode("sh.mschf.ratking.hpke.v1");

export interface SealRequest {
  readonly payload: Defs.SigningPayloadValue;
  readonly signingKeyId: string;
  readonly signingKey: CryptoKey;
  readonly recipientKeyId: string;
  readonly recipientKey: CryptoKey;
}

export const seal = Effect.fn("Envelope.seal")(function* seal(
  request: SealRequest
) {
  const { payload } = request;

  if (
    !supported(payload) ||
    request.recipientKeyId !== payload.aad.recipientKeyId ||
    !request.recipientKeyId.startsWith(`${payload.aad.recipientDid}#`) ||
    !request.signingKeyId.startsWith(`${payload.aad.senderDid}#`)
  ) {
    return yield* Effect.fail(
      new EnvelopeFailure({
        reason: "Unsupported envelope or unauthorized key id",
      })
    );
  }

  const validated = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SigningPayload)
  )(payload);

  const bytes = signingBytes(validated);
  const signature = yield* sign(request.signingKey, bytes);

  const signed = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SignedMessage)
  )({
    appSignature: {
      algorithm: "ES256",
      keyId: request.signingKeyId,
      signature,
    },
    canonicalSigningBytes: bytes,
  });

  const context = yield* cryptoOperation(() =>
    hpke.createSenderContext({ info, recipientPublicKey: request.recipientKey })
  );

  const header = {
    aad: payload.aad,
    enc: new Uint8Array(context.enc),
    suite: payload.suite,
    version: payload.version,
  };

  const ciphertext = yield* cryptoOperation(() =>
    context.seal(canonical(signed), aadBytes(header))
  );

  return yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.EncryptedEnvelope)
  )({ ...header, ciphertext: new Uint8Array(ciphertext) });
});

export interface OpenRequest {
  readonly envelope: Defs.EncryptedEnvelopeValue;
  readonly recipientDid: string;
  readonly recipientKeyId: string;
  readonly recipientKey: CryptoKey;
  readonly resolveSigningKey: (
    senderDid: string,
    keyId: string
  ) => Effect.Effect<CryptoKey, EnvelopeFailure>;
}

export const open = Effect.fn("Envelope.open")(function* open(
  request: OpenRequest
) {
  const envelope = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.EncryptedEnvelope)
  )(request.envelope);

  if (
    !supported(envelope) ||
    envelope.aad.recipientDid !== request.recipientDid ||
    envelope.aad.recipientKeyId !== request.recipientKeyId ||
    !request.recipientKeyId.startsWith(`${request.recipientDid}#`)
  ) {
    return yield* Effect.fail(
      new EnvelopeFailure({ reason: "Unsupported envelope or wrong recipient" })
    );
  }

  const context = yield* cryptoOperation(() =>
    hpke.createRecipientContext({
      enc: envelope.enc,
      info,
      recipientKey: request.recipientKey,
    })
  );

  const plaintext = yield* cryptoOperation(() =>
    context.open(envelope.ciphertext, aadBytes(envelope))
  );

  const signed = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SignedMessage)
  )(yield* canonicalDecode(new Uint8Array(plaintext)));

  const bytes = signed.canonicalSigningBytes;

  if (!equalBytes(bytes.subarray(0, signatureDomain.length), signatureDomain)) {
    return yield* Effect.fail(
      new EnvelopeFailure({ reason: "Wrong signature domain" })
    );
  }

  const payload = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.SigningPayload)
  )(yield* canonicalDecode(bytes.subarray(signatureDomain.length)));

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

  const key = yield* request.resolveSigningKey(
    envelope.aad.senderDid,
    app.keyId
  );

  if (!(yield* verify(key, bytes, app.signature))) {
    return yield* Effect.fail(
      new EnvelopeFailure({ reason: "Invalid application signature" })
    );
  }

  return payload;
});

export {
  aadBytes,
  canonical,
  canonicalDecode,
  concatenate,
  equalBytes,
  signatureDomain,
  signingBytes,
  supported,
  suite,
} from "./canonical.ts";

export { lowS, normalizeSignature, p256Order, sign, verify } from "./es256.ts";

export { EnvelopeFailure } from "./failure.ts";

export { cryptoOperation } from "./webcrypto.ts";
