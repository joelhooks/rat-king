/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { sign } from "@rat-king/envelope/es256";
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Effect, Layer, Schema } from "effect";

const failure = (error: string, status: number, message?: string) => {
  if (message === undefined) {
    return new XrpcFailure({ error, response: {}, status });
  }

  return new XrpcFailure({ error, message, response: {}, status });
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
