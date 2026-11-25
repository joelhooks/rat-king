/* oxlint-disable typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { sign, verify } from "@rat-king/envelope/es256";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Effect, Layer, Schema } from "effect";

import { ServiceAuthFailure } from "./auth-failure.ts";
import { ReplayAuthority } from "./replay.ts";

export {
  sign,
  verify,
  lowS,
  normalizeSignature,
  p256Order,
} from "@rat-king/envelope/es256";

export { ReplayAuthority } from "./replay.ts";

export { ServiceAuthFailure } from "./auth-failure.ts";

export type { ReplayInterface } from "./replay.ts";

const failure = (
  error: string,
  status: number,
  message?: string
): XrpcFailure => {
  if (message === undefined) {
    return new ServiceAuthFailure({ error, response: {}, status });
  }

  return new ServiceAuthFailure({ error, message, response: {}, status });
};

export const base64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const unbase64url = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0
  );

export const Claims = Schema.Struct({
  aud: Schema.String,
  exp: Schema.Int,
  iat: Schema.Int,
  iss: Schema.String,
  jti: Schema.String.check(Schema.isMinLength(16)),
  lxm: Schema.String,
});

export type ClaimsValue = typeof Claims.Type;

type ClaimsCheck =
  | "aud"
  | "lxm"
  | "iat-future"
  | "expired"
  | "exp-before-iat"
  | "lifetime"
  | "stale";

interface ClaimsDiagnostics {
  readonly check: ClaimsCheck;
  readonly claimedIssuer: ClaimsValue["iss"];
}

const claimsDiagnostics = new WeakMap<XrpcFailure, ClaimsDiagnostics>();

export const getClaimsDiagnostics = (error: XrpcFailure) =>
  claimsDiagnostics.get(error);

const authFailure = (
  error: string,
  status = 400,
  message = error
): XrpcFailure =>
  new ServiceAuthFailure({
    error,
    message,
    response: { error, message },
    status,
  });

const PublicJwk = Schema.Struct({
  crv: Schema.Literal("P-256"),
  d: Schema.optionalKey(Schema.Never),
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});

export const Document = Schema.Struct({
  authentication: Schema.Array(Schema.String),
  id: Schema.String,
  keyAgreement: Schema.Array(Schema.String),
  verificationMethod: Schema.Array(
    Schema.Struct({
      controller: Schema.String,
      id: Schema.String,
      publicKeyJwk: PublicJwk,
    })
  ),
});

export const Documents = Schema.Array(Document);

export type DocumentsValue = typeof Documents.Type;

export class DidResolver extends Context.Service<
  DidResolver,
  {
    readonly resolve: (
      did: string,
      keyId: string,
      purpose: "authentication" | "keyAgreement"
    ) => Effect.Effect<CryptoKey, XrpcFailure>;
  }
>()("mailbox/DidResolver") {}

export const documentResolver = (
  lookup: (
    did: string
  ) => Effect.Effect<typeof Document.Type | undefined, XrpcFailure>
) =>
  Layer.succeed(
    DidResolver,
    DidResolver.of({
      resolve: Effect.fn("DidResolver.resolve")(
        function* resolve(did, keyId, purpose) {
          const document = yield* lookup(did);

          const method = document?.verificationMethod.find(
            (candidate) =>
              candidate.id === keyId && candidate.controller === did
          );

          if (
            !did.startsWith("did:web:") ||
            !method ||
            document?.[purpose].includes(keyId) !== true
          ) {
            return yield* Effect.fail(
              failure("Forbidden", 403, "Unauthorized DID key")
            );
          }

          const algorithm =
            purpose === "authentication"
              ? { name: "ECDSA", namedCurve: "P-256" }
              : { name: "ECDH", namedCurve: "P-256" };

          return yield* cryptoOperation(() =>
            crypto.subtle.importKey(
              "jwk",
              method.publicKeyJwk,
              algorithm,
              true,
              purpose === "authentication" ? ["verify"] : []
            )
          ).pipe(Effect.mapError(() => failure("AuthRequired", 401)));
        }
      ),
    })
  );

export const staticResolver = (documents: DocumentsValue) =>
  documentResolver((did) =>
    Effect.succeed(documents.find((candidate) => candidate.id === did))
  );

const Header = Schema.Struct({
  alg: Schema.Literal("ES256"),
  kid: Schema.optionalKey(Schema.String),
  typ: Schema.optionalKey(Schema.Literal("JWT")),
});

export interface AuthenticateRequest {
  readonly authorization: string | null;
  readonly audience: string;
  readonly nsid: string;
  readonly now: number;
  readonly skewSeconds?: number;
}

const failedClaimsCheck = (
  claims: ClaimsValue,
  request: AuthenticateRequest
): ClaimsCheck | undefined => {
  const now = Math.floor(request.now / 1000);

  if (claims.aud !== request.audience) {
    return "aud";
  }

  if (claims.lxm !== request.nsid) {
    return "lxm";
  }

  if (claims.iat > now + (request.skewSeconds ?? 0)) {
    return "iat-future";
  }

  if (claims.exp <= now) {
    return "expired";
  }

  if (claims.exp <= claims.iat) {
    return "exp-before-iat";
  }

  if (now - claims.iat > 60) {
    return "stale";
  }

  if (claims.exp - claims.iat > 60) {
    return "lifetime";
  }

  return undefined;
};

const json = (text: string) =>
  Effect.try({
    catch: () => authFailure("AuthRequired", 401),
    try: () => new TextDecoder().decode(unbase64url(text)),
  });

export const authenticateClaims = Effect.fn("ServiceAuth.authenticateClaims")(
  function* authenticateClaims(request: AuthenticateRequest) {
    const token = request.authorization?.match(
      /^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u
    )?.groups?.token;

    if (token === undefined || token === "") {
      return yield* Effect.fail(authFailure("AuthRequired", 401));
    }

    const [headerText = "", claimsText = "", signatureText = ""] =
      token.split(".");

    const header = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Header)
    )(yield* json(headerText)).pipe(
      Effect.mapError(() => authFailure("AuthRequired", 401))
    );

    const claims = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Claims)
    )(yield* json(claimsText)).pipe(
      Effect.mapError(() => authFailure("AuthRequired", 401))
    );

    const check = failedClaimsCheck(claims, request);

    if (check !== undefined) {
      const refusal = authFailure(
        "AuthRequired",
        401,
        "Invalid service-auth claims"
      );

      claimsDiagnostics.set(refusal, { check, claimedIssuer: claims.iss });

      return yield* Effect.fail(refusal);
    }

    const kid = header.kid ?? "#atproto";
    const keyId = kid.startsWith("#") ? `${claims.iss}${kid}` : kid;
    const resolver = yield* DidResolver;
    const key = yield* resolver.resolve(claims.iss, keyId, "authentication");

    const signature = yield* Effect.try({
      catch: () => authFailure("AuthRequired", 401),
      try: () => unbase64url(signatureText),
    });

    const valid = yield* verify(
      key,
      new TextEncoder().encode(`${headerText}.${claimsText}`),
      signature
    ).pipe(Effect.mapError(() => authFailure("AuthRequired", 401)));

    if (!valid) {
      return yield* Effect.fail(authFailure("AuthRequired", 401));
    }

    const replay = yield* ReplayAuthority;
    yield* replay.consume(claims, request.now);

    return claims;
  }
);

export const serviceToken = Effect.fn("ServiceAuth.sign")(
  function* serviceToken(claims: ClaimsValue, key: CryptoKey, kid?: string) {
    const header = base64url(
      new TextEncoder().encode(
        JSON.stringify({ alg: "ES256", kid: kid ?? "#atproto", typ: "JWT" })
      )
    );

    const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const bytes = new TextEncoder().encode(`${header}.${payload}`);

    return `${header}.${payload}.${base64url(yield* sign(key, bytes))}`;
  }
);
