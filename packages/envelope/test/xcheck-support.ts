/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Lazy WebCrypto adapters return the provider Promise. */
import * as Defs from "@rat-king/lexicon/defs";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Arbitrary, Effect, Schema } from "effect";

import { cryptoOperation, hpke, suite } from "../src/envelope.ts";

export const PayloadWire = Schema.Struct({
  aad: Schema.Struct({
    expiresAt: Schema.Literal("2099-01-01T00:00:00+00:00"),
    future: Schema.Literals(["bound", "λ🐀"]),
    futureInteger: Schema.Literals([-24, 0, 256]),
    futureNested: Schema.Struct({
      bytes: Schema.Struct({ $bytes: Schema.Literal("AP+A") }),
      list: Schema.Tuple([Schema.Null, Schema.Literal(true)]),
    }),
    messageId: Schema.Literal("3m7x2ka4xv22a"),
    recipientDid: Schema.Literal("did:web:recipient.example.invalid"),
    recipientKeyId: Schema.Literal(
      "did:web:recipient.example.invalid#encryption"
    ),
    senderDid: Schema.Literal("did:web:sender.example.invalid"),
  }),
  body: Schema.Struct({ $bytes: Schema.Literals(["", "aGVsbG8=", "AP+A"]) }),
  suite: Schema.Struct({
    aeadId: Schema.Literal(suite.aeadId),
    kdfId: Schema.Literal(suite.kdfId),
    kemId: Schema.Literal(suite.kemId),
  }),
  urgent: Schema.optionalKey(Schema.Literal(true)),
  version: Schema.Literal(1),
});

export const payloadArbitrary = Arbitrary.schema(PayloadWire);

export const Fixture = Schema.Struct({
  canonicalReject: Schema.Array(
    Schema.Struct({
      accepted: Schema.Literal(false),
      bytes: Runtime.Bytes,
      name: Schema.String,
    })
  ),
  implementation: Schema.String,
  info: Runtime.Bytes,
  recipientPrivate: Runtime.Bytes,
  recipientPublic: Runtime.Bytes,
  signingPrivate: Runtime.Bytes,
  signingPublic: Runtime.Bytes,
  vectors: Schema.Array(
    Schema.Struct({
      aadBytes: Runtime.Bytes,
      envelope: Defs.EncryptedEnvelope,
      payload: Defs.SigningPayload,
      reject: Schema.Array(
        Schema.Struct({
          envelope: Defs.EncryptedEnvelope,
          name: Schema.String,
        })
      ),
      signingBytes: Runtime.Bytes,
    })
  ),
});

export const importKeys = Effect.fn("Xcheck.importKeys")(function* importKeys(
  fixture: typeof Fixture.Type
) {
  const senderPublic = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(fixture.signingPublic),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    )
  );

  const publicJwk = yield* cryptoOperation(() =>
    crypto.subtle.exportKey("jwk", senderPublic)
  );

  const senderPrivate = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      {
        ...publicJwk,
        d: Buffer.from(fixture.signingPrivate).toString("base64url"),
        key_ops: ["sign"],
      },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    )
  );

  const recipientPrivate = yield* cryptoOperation(() =>
    hpke.kem.deserializePrivateKey(fixture.recipientPrivate)
  );

  const recipientPublic = yield* cryptoOperation(() =>
    hpke.kem.deserializePublicKey(fixture.recipientPublic)
  );

  return { recipientPrivate, recipientPublic, senderPrivate, senderPublic };
});

export const requestFor = (
  envelope: Defs.EncryptedEnvelopeValue,
  keys: Effect.Success<ReturnType<typeof importKeys>>
) => ({
  envelope,
  recipientDid: envelope.aad.recipientDid,
  recipientKey: keys.recipientPrivate,
  recipientKeyId: envelope.aad.recipientKeyId,
  resolveSigningKey: () => Effect.succeed(keys.senderPublic),
});
