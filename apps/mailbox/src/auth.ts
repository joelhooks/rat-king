/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { verify } from "@rat-king/envelope/es256";
import { Claims, DidResolver, unbase64url } from "@rat-king/mailbox-client";
import { Effect, Schema } from "effect";

import { failure } from "./failure.ts";
import { ReplayAuthority } from "./replay.ts";

export {
  base64url,
  unbase64url,
  Claims,
  Document,
  Documents,
  DidResolver,
  documentResolver,
  staticResolver,
  serviceToken,
} from "@rat-king/mailbox-client";

export type { ClaimsValue, DocumentsValue } from "@rat-king/mailbox-client";

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
}

const json = (text: string) =>
  Effect.try({
    catch: () => failure("AuthRequired", 401),
    try: () => new TextDecoder().decode(unbase64url(text)),
  });

export const authenticate = Effect.fn("ServiceAuth.authenticate")(
  function* authenticate(request: AuthenticateRequest) {
    const token = request.authorization?.match(
      /^Bearer (?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u
    )?.groups?.token;

    if (token === undefined || token === "") {
      return yield* Effect.fail(failure("AuthRequired", 401));
    }

    const [headerText = "", claimsText = "", signatureText = ""] =
      token.split(".");

    const header = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Header)
    )(yield* json(headerText)).pipe(
      Effect.mapError(() => failure("AuthRequired", 401))
    );

    const claims = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Claims)
    )(yield* json(claimsText)).pipe(
      Effect.mapError(() => failure("AuthRequired", 401))
    );

    const now = Math.floor(request.now / 1000);

    if (
      claims.aud !== request.audience ||
      claims.lxm !== request.nsid ||
      claims.iat > now ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60 ||
      now - claims.iat > 60
    ) {
      return yield* Effect.fail(
        failure("AuthRequired", 401, "Invalid service-auth claims")
      );
    }

    const kid = header.kid ?? "#atproto";
    const keyId = kid.startsWith("#") ? `${claims.iss}${kid}` : kid;
    const resolver = yield* DidResolver;
    const key = yield* resolver.resolve(claims.iss, keyId, "authentication");

    const signature = yield* Effect.try({
      catch: () => failure("AuthRequired", 401),
      try: () => unbase64url(signatureText),
    });

    const valid = yield* verify(
      key,
      new TextEncoder().encode(`${headerText}.${claimsText}`),
      signature
    ).pipe(Effect.mapError(() => failure("AuthRequired", 401)));

    if (!valid) {
      return yield* Effect.fail(failure("AuthRequired", 401));
    }

    const replay = yield* ReplayAuthority;
    yield* replay.consume(claims, request.now);

    return claims.iss;
  }
);

export { ReplayAuthority } from "./replay.ts";
