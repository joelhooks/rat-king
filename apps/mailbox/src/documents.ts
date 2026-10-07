import { canonical } from "@rat-king/envelope/canonical";
/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Lazy DO RPC adapters. */
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Effect, Schema } from "effect";

import { base64url, Document, Documents, documentResolver } from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { failure } from "./failure.ts";

export const didAllowlist = (value: string | undefined) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    value ?? "[]"
  );

export const configuredDocuments = (env: Bindings) =>
  Schema.decodeUnknownSync(Documents)(JSON.parse(env.DID_DOCUMENTS));

export const lookupPeerDocument = Effect.fn("Directory.lookup")(
  function* lookupPeerDocument(
    input: {
      readonly configured: typeof Documents.Type;
      readonly allowlist: readonly string[];
      readonly registered: (
        did: string
      ) => Effect.Effect<string | undefined, XrpcFailure>;
    },
    issuer: string,
    did: string
  ) {
    const { configured } = input;

    const allowed = new Set([
      ...configured.map((document) => document.id),
      ...input.allowlist,
    ]);

    if (!allowed.has(issuer) || !allowed.has(did)) {
      return yield* Effect.fail(failure("Forbidden", 403));
    }

    const registered = yield* input.registered(did);

    const document =
      registered === undefined
        ? configured.find((candidate) => candidate.id === did)
        : yield* Schema.decodeEffect(Schema.fromJsonString(Document))(
            registered
          ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

    if (document === undefined || document.id !== did) {
      return yield* Effect.fail(failure("DocumentNotFound", 404));
    }

    const seeded = configured.find((candidate) => candidate.id === did);

    if (
      seeded !== undefined &&
      base64url(canonical(seeded)) !== base64url(canonical(document))
    ) {
      return yield* Effect.fail(failure("DocumentConflict", 409));
    }

    return {
      authentication: document.authentication,
      id: document.id,
      keyAgreement: document.keyAgreement,
      verificationMethod: document.verificationMethod.map((method) => ({
        controller: method.controller,
        id: method.id,
        publicKeyJwk: {
          crv: method.publicKeyJwk.crv,
          kty: method.publicKeyJwk.kty,
          x: method.publicKeyJwk.x,
          y: method.publicKeyJwk.y,
        },
      })),
    };
  }
);

export const peerDocument = (env: Bindings, issuer: string, did: string) =>
  lookupPeerDocument(
    {
      allowlist: [
        ...didAllowlist(env.OPERATOR_DIDS),
        ...didAllowlist(env.OBSERVER_DIDS),
      ],
      configured: configuredDocuments(env),
      registered: (peer) =>
        Effect.tryPromise({
          catch: () => failure("MailboxUnavailable", 503),
          try: () => env.MAILBOX.getByName(peer).registeredDocument(),
        }),
    },
    issuer,
    did
  );

export const documentsLayer = (env: Bindings) => {
  const documents = configuredDocuments(env);

  return documentResolver(
    Effect.fn("DidResolver.lookup")(function* lookup(did) {
      if (!did.startsWith("did:web:")) {
        return yield* Effect.fail(failure("Forbidden", 403));
      }

      const configured = documents.find((candidate) => candidate.id === did);

      if (configured !== undefined) {
        return configured;
      }

      const registered = yield* Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () => env.MAILBOX.getByName(did).registeredDocument(),
      });

      return registered === undefined
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(Document))(
            registered
          ).pipe(Effect.mapError(() => failure("AuthRequired", 401)));
    })
  );
};
