import * as Defs from "@rat-king/lexicon/defs";
import { DateTime, Schema } from "effect";

export const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

export const serial = integer(1, 80_000);

export const epoch = integer(1_700_000_000_000, 1_900_000_000_000);

export const alpha = Schema.String.check(
  Schema.isPattern(/^[a-z]+$/u),
  Schema.isMaxLength(12)
);

export const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

export const did = (n: number) => `did:web:agent-${n}.example.invalid`;

export const template = "did:web:example.invalid:actors:{agent}";

export const publicDoc = (issuer: string, n: number) => ({
  authentication: [`${issuer}#atproto`],
  id: issuer,
  keyAgreement: [`${issuer}#enc`],
  verificationMethod: [
    {
      controller: issuer,
      id: `${issuer}#atproto`,
      publicKeyJwk: {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: `fixture-x-${n}`,
        y: `fixture-y-${n}`,
      },
    },
    {
      controller: issuer,
      id: `${issuer}#enc`,
      publicKeyJwk: {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: `fixture-enc-x-${n}`,
        y: `fixture-enc-y-${n}`,
      },
    },
  ],
});

export const envelope = Schema.decodeUnknownSync(Defs.EncryptedEnvelope);

export const receipt = Schema.decodeUnknownSync(Defs.Receipt);
