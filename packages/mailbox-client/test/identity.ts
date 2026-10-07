/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy WebCrypto test adapters. */
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";

import { Identity, PrivateJwk } from "../src/identity.ts";

const key = (name: "ECDSA" | "ECDH") =>
  Effect.gen(function* generateTestKey() {
    const pair = yield* cryptoOperation(() =>
      crypto.subtle.generateKey(
        { name, namedCurve: "P-256" },
        true,
        name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"]
      )
    );

    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ privateKey: Schema.instanceOf(CryptoKey) })
    )(pair);

    return yield* Schema.decodeUnknownEffect(PrivateJwk)(
      yield* cryptoOperation(() =>
        crypto.subtle.exportKey("jwk", decoded.privateKey)
      )
    );
  });

export const identity = (did: string) =>
  Effect.gen(function* createTestIdentity() {
    return yield* Schema.decodeUnknownEffect(Identity)({
      agreement: yield* key("ECDH"),
      did,
      signing: yield* key("ECDSA"),
    });
  });

const publicKey = (value: typeof PrivateJwk.Type) => ({
  crv: value.crv,
  kty: value.kty,
  x: value.x,
  y: value.y,
});

export const document = (value: typeof Identity.Type) =>
  Schema.decodeUnknownEffect(Schema.toType(Defs.DidDocument))({
    authentication: [`${value.did}#atproto`],
    id: value.did,
    keyAgreement: [`${value.did}#encryption`],
    verificationMethod: [
      {
        controller: value.did,
        id: `${value.did}#atproto`,
        publicKeyJwk: publicKey(value.signing),
      },
      {
        controller: value.did,
        id: `${value.did}#encryption`,
        publicKeyJwk: publicKey(value.agreement),
      },
    ],
  });
