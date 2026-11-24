/* oxlint-disable eslint/max-classes-per-file -- Signed admin requests distinguish bad authority from bad targets. */
import { PublicKey, Signatures } from "@rat-king/lexicon/trust";
import { Clock, Config, Effect, Option, Predicate, Schema } from "effect";

import { readBody } from "../http.ts";
import { Key } from "./keys.ts";
import { AccountDid, didForHost, Handle, handleForHost } from "./names.ts";

export const Issuer = Schema.Struct({
  did: Schema.String.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/u)
  ),
  key: PublicKey,
});

export const issuerConfig = Config.option(
  Config.schema(Schema.fromJsonString(Issuer), "RATKING_IDENTITY_ISSUER")
);

export const Mutation = Schema.TaggedUnion({
  ClaimHandle: { handle: Handle },
  PublishKey: { key: Key },
  Register: {},
  Retire: {},
  RotateKey: { key: Key },
});

const Payload = Schema.fromJsonString(
  Schema.Struct({
    audience: AccountDid,
    did: AccountDid,
    expiresAt: Schema.Int,
    issuedAt: Schema.Int,
    issuer: Issuer.fields.did,
    mutation: Mutation,
    nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  })
);

const Signed = Schema.fromJsonString(
  Schema.Struct({
    payload: Schema.String,
    signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/u)),
  })
);

class AdminUnauthorized extends Schema.TaggedError<AdminUnauthorized>()(
  "AdminUnauthorized",
  {}
) {}

class InvalidTarget extends Schema.TaggedError<InvalidTarget>()(
  "InvalidTarget",
  {}
) {}

export const adminPath = "/identity/admin";

const maxLifetimeMillis = 5 * 60 * 1000;

export const adminBytes = (payload: string) =>
  new TextEncoder().encode(`ratking.identity.admin.v1\0${payload}`);

const parseSigned = Schema.decodeUnknownEffect(Signed, {
  onExcessProperty: "error",
});

const parsePayload = Schema.decodeUnknownEffect(Payload, {
  onExcessProperty: "error",
});

export const verifyAdmin = Effect.fn("Identity.verifyAdmin")(
  function* verifyAdmin({
    issuer,
    request,
    zone,
  }: {
    readonly issuer: typeof Issuer.Type | undefined;
    readonly request: Request;
    readonly zone: string;
  }) {
    if (issuer === undefined) {
      return yield* new AdminUnauthorized({});
    }

    const body = yield* readBody(request);

    const signed = yield* parseSigned(body).pipe(
      Effect.mapError(() => new AdminUnauthorized({}))
    );

    const signatures = yield* Signatures;
    const bytes = adminBytes(signed.payload);

    const valid = yield* signatures
      .verify(issuer.key, bytes, signed.signature)
      .pipe(Effect.mapError(() => new AdminUnauthorized({})));

    if (!valid) {
      return yield* new AdminUnauthorized({});
    }

    const payload = yield* parsePayload(signed.payload);
    const now = yield* Clock.currentTimeMillis;

    if (
      payload.issuer !== issuer.did ||
      payload.audience !== `did:web:${zone}` ||
      payload.issuedAt > now ||
      payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt > maxLifetimeMillis
    ) {
      return yield* new AdminUnauthorized({});
    }

    if (
      Option.isNone(didForHost(payload.did.slice("did:web:".length), zone)) ||
      (Predicate.isTagged(payload.mutation, "ClaimHandle") &&
        Option.isNone(handleForHost(payload.mutation.handle, zone)))
    ) {
      return yield* new InvalidTarget({});
    }

    return {
      commandId: yield* signatures.digest(bytes),
      did: payload.did,
      mutation: payload.mutation,
    };
  }
);

export type VerifiedAdmin = Effect.Success<ReturnType<typeof verifyAdmin>>;
