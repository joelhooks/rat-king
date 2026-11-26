/* oxlint-disable typescript/promise-function-async -- Lazy WebCrypto adapter. */
import type { EnvelopeFailure, RecipientOpener } from "@rat-king/envelope";
import type { Es256Signer } from "@rat-king/envelope/es256";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Effect, Schema } from "effect";

export const PublicJwk = Schema.Struct({
  crv: Schema.Literal("P-256"),
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});

export const PrivateJwk = Schema.Struct({
  ...PublicJwk.fields,
  d: Schema.String,
});

export const Identity = Schema.Struct({
  agreement: PrivateJwk,
  did: Schema.String.check(Schema.isPattern(/^did:web:/u)),
  signing: PrivateJwk,
});

export type IdentityValue = typeof Identity.Type;

export interface ManagedIdentity {
  readonly agreement: typeof PublicJwk.Type;
  readonly did: string;
  readonly signing: typeof PublicJwk.Type;
  readonly sign: Es256Signer;
  readonly open: RecipientOpener;
}

export type RuntimeIdentity = IdentityValue | ManagedIdentity;

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

export const signingFor = (
  identity: RuntimeIdentity
): Effect.Effect<CryptoKey | Es256Signer, EnvelopeFailure> =>
  "sign" in identity ? Effect.succeed(identity.sign) : importSigning(identity);

export const recipientFor = (
  identity: RuntimeIdentity
): Effect.Effect<CryptoKey | RecipientOpener, EnvelopeFailure> =>
  "open" in identity
    ? Effect.succeed(identity.open)
    : importAgreement(identity);
