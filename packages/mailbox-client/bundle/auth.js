// packages/envelope/src/es256.ts
import { Effect as Effect2 } from "effect";

// packages/envelope/src/bytes.ts
var concatenate = (...parts) => {
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

// packages/envelope/src/failure.ts
import { Schema } from "effect";
var EnvelopeFailure = class extends Schema.TaggedError()(
  "EnvelopeFailure",
  { reason: Schema.String }
) {
};

// packages/envelope/src/webcrypto.ts
import { Effect } from "effect";
var cryptoOperation = (operation) => Effect.tryPromise({
  catch: () => new EnvelopeFailure({ reason: "Cryptographic operation rejected" }),
  try: operation
});

// packages/envelope/src/es256.ts
var p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
var scalar = (bytes) => BigInt(
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
);
var scalarBytes = (value) => Uint8Array.from(
  value.toString(16).padStart(64, "0").match(/../gu) ?? [],
  (pair) => Number.parseInt(pair, 16)
);
var normalizeSignature = (signature) => {
  if (signature.length !== 64) {
    throw new EnvelopeFailure({ reason: "ES256 requires 64 bytes" });
  }
  const s = scalar(signature.subarray(32));
  return concatenate(
    signature.subarray(0, 32),
    scalarBytes(s > p256Order / 2n ? p256Order - s : s)
  );
};
var lowS = (signature) => signature.length === 64 && scalar(signature.subarray(0, 32)) > 0n && scalar(signature.subarray(0, 32)) < p256Order && scalar(signature.subarray(32)) > 0n && scalar(signature.subarray(32)) <= p256Order / 2n;
var sign = Effect2.fn("Envelope.sign")(function* sign2(key, bytes) {
  const signature = yield* cryptoOperation(
    () => crypto.subtle.sign(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(bytes)
    )
  );
  return normalizeSignature(new Uint8Array(signature));
});
var verify = Effect2.fn("Envelope.verify")(function* verify2(key, bytes, signature) {
  if (!lowS(signature)) {
    return false;
  }
  return yield* cryptoOperation(
    () => crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      key,
      new Uint8Array(signature),
      new Uint8Array(bytes)
    )
  );
});

// packages/mailbox-client/src/auth.ts
import { Context as Context2, Effect as Effect3, Layer, Schema as Schema3 } from "effect";

// packages/mailbox-client/src/auth-failure.ts
import { Schema as Schema2 } from "effect";
var ServiceAuthFailure = class extends Schema2.TaggedError()(
  "XrpcFailure",
  {
    error: Schema2.String,
    message: Schema2.optionalKey(Schema2.String),
    response: Schema2.Record(Schema2.String, Schema2.Json),
    status: Schema2.Int
  }
) {
};

// packages/mailbox-client/src/replay.ts
import { Context } from "effect";
var ReplayAuthority = class extends Context.Service()("mailbox/ReplayAuthority") {
};

// packages/mailbox-client/src/auth.ts
var failure = (error, status, message) => {
  if (message === void 0) {
    return new ServiceAuthFailure({ error, response: {}, status });
  }
  return new ServiceAuthFailure({ error, message, response: {}, status });
};
var base64url = (bytes) => btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
var unbase64url = (text) => Uint8Array.from(
  atob(text.replaceAll("-", "+").replaceAll("_", "/")),
  (character) => character.codePointAt(0) ?? 0
);
var Claims = Schema3.Struct({
  aud: Schema3.String,
  exp: Schema3.Int,
  iat: Schema3.Int,
  iss: Schema3.String,
  jti: Schema3.String.check(Schema3.isMinLength(16)),
  lxm: Schema3.String
});
var claimsDiagnostics = /* @__PURE__ */ new WeakMap();
var getClaimsDiagnostics = (error) => claimsDiagnostics.get(error);
var authFailure = (error, status = 400, message = error) => new ServiceAuthFailure({
  error,
  message,
  response: { error, message },
  status
});
var PublicJwk = Schema3.Struct({
  crv: Schema3.Literal("P-256"),
  d: Schema3.optionalKey(Schema3.Never),
  kty: Schema3.Literal("EC"),
  x: Schema3.String,
  y: Schema3.String
});
var Document = Schema3.Struct({
  authentication: Schema3.Array(Schema3.String),
  id: Schema3.String,
  keyAgreement: Schema3.Array(Schema3.String),
  verificationMethod: Schema3.Array(
    Schema3.Struct({
      controller: Schema3.String,
      id: Schema3.String,
      publicKeyJwk: PublicJwk
    })
  )
});
var Documents = Schema3.Array(Document);
var DidResolver = class extends Context2.Service()("mailbox/DidResolver") {
};
var documentResolver = (lookup) => Layer.succeed(
  DidResolver,
  DidResolver.of({
    resolve: Effect3.fn("DidResolver.resolve")(
      function* resolve(did, keyId, purpose) {
        const document = yield* lookup(did);
        const method = document?.verificationMethod.find(
          (candidate) => candidate.id === keyId && candidate.controller === did
        );
        if (!did.startsWith("did:web:") || !method || document?.[purpose].includes(keyId) !== true) {
          return yield* Effect3.fail(
            failure("Forbidden", 403, "Unauthorized DID key")
          );
        }
        const algorithm = purpose === "authentication" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "ECDH", namedCurve: "P-256" };
        return yield* cryptoOperation(
          () => crypto.subtle.importKey(
            "jwk",
            method.publicKeyJwk,
            algorithm,
            true,
            purpose === "authentication" ? ["verify"] : []
          )
        ).pipe(Effect3.mapError(() => failure("AuthRequired", 401)));
      }
    )
  })
);
var staticResolver = (documents) => documentResolver(
  (did) => Effect3.succeed(documents.find((candidate) => candidate.id === did))
);
var Header = Schema3.Struct({
  alg: Schema3.Literal("ES256"),
  kid: Schema3.optionalKey(Schema3.String),
  typ: Schema3.optionalKey(Schema3.Literal("JWT"))
});
var failedClaimsCheck = (claims, request) => {
  const now = Math.floor(request.now / 1e3);
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
  return void 0;
};
var json = (text) => Effect3.try({
  catch: () => authFailure("AuthRequired", 401),
  try: () => new TextDecoder().decode(unbase64url(text))
});
var authenticateClaims = Effect3.fn("ServiceAuth.authenticateClaims")(
  function* authenticateClaims2(request) {
    const token = request.authorization?.match(
      /^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u
    )?.groups?.token;
    if (token === void 0 || token === "") {
      return yield* Effect3.fail(authFailure("AuthRequired", 401));
    }
    const [headerText = "", claimsText = "", signatureText = ""] = token.split(".");
    const header = yield* Schema3.decodeUnknownEffect(
      Schema3.fromJsonString(Header)
    )(yield* json(headerText)).pipe(
      Effect3.mapError(() => authFailure("AuthRequired", 401))
    );
    const claims = yield* Schema3.decodeUnknownEffect(
      Schema3.fromJsonString(Claims)
    )(yield* json(claimsText)).pipe(
      Effect3.mapError(() => authFailure("AuthRequired", 401))
    );
    const check = failedClaimsCheck(claims, request);
    if (check !== void 0) {
      const refusal = authFailure(
        "AuthRequired",
        401,
        "Invalid service-auth claims"
      );
      claimsDiagnostics.set(refusal, { check, claimedIssuer: claims.iss });
      return yield* Effect3.fail(refusal);
    }
    const kid = header.kid ?? "#atproto";
    const keyId = kid.startsWith("#") ? `${claims.iss}${kid}` : kid;
    const resolver = yield* DidResolver;
    const key = yield* resolver.resolve(claims.iss, keyId, "authentication");
    const signature = yield* Effect3.try({
      catch: () => authFailure("AuthRequired", 401),
      try: () => unbase64url(signatureText)
    });
    const valid = yield* verify(
      key,
      new TextEncoder().encode(`${headerText}.${claimsText}`),
      signature
    ).pipe(Effect3.mapError(() => authFailure("AuthRequired", 401)));
    if (!valid) {
      return yield* Effect3.fail(authFailure("AuthRequired", 401));
    }
    const replay = yield* ReplayAuthority;
    yield* replay.consume(claims, request.now);
    return claims;
  }
);
var serviceToken = Effect3.fn("ServiceAuth.sign")(
  function* serviceToken2(claims, key, kid) {
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
export {
  Claims,
  DidResolver,
  Document,
  Documents,
  ReplayAuthority,
  ServiceAuthFailure,
  authenticateClaims,
  base64url,
  documentResolver,
  getClaimsDiagnostics,
  lowS,
  normalizeSignature,
  p256Order,
  serviceToken,
  sign,
  staticResolver,
  unbase64url,
  verify
};
