/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy WebCrypto adapter. */
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Schema } from "effect";

export const PrivateJwk = Schema.Struct({
  crv: Schema.Literal("P-256"),
  d: Schema.String,
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});

export const Identity = Schema.Struct({
  agreement: PrivateJwk,
  did: Schema.String.check(Schema.isPattern(/^did:web:/u)),
  signing: PrivateJwk,
});

export type IdentityValue = typeof Identity.Type;

export const importSigning = (identity: IdentityValue) =>
  cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      identity.signing,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    )
  );

export const importAgreement = (identity: IdentityValue) =>
  cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      identity.agreement,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    )
  );
