/* oxlint-disable typescript/promise-function-async -- Lazy WebCrypto and fetch boundaries for Effect.tryPromise. */
import { Clock, Effect, Option, Schema } from "effect";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";

import { adminBytes, adminPath, Issuer, Mutation } from "./admin.ts";
import { Key } from "./keys.ts";
import { AccountDid, Handle, identityZone } from "./names.ts";
import { Document } from "./views.ts";

export const SeedPlan = Schema.fromJsonString(
  Schema.Struct({
    apexKeys: Schema.Array(Key),
  })
);

const SigningIdentity = Schema.fromJsonString(
  Schema.Struct({
    did: Issuer.fields.did,
    signing: Schema.Struct({
      ...Issuer.fields.key.fields,
      d: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
    }),
  })
);

export class SeedFailure extends Schema.TaggedError<
  SeedFailure,
  { readonly brand: unique symbol }
>()("SeedFailure", { reason: Schema.String }) {}

const failure = (reason: string) => new SeedFailure({ reason });

export const importIssuer = Effect.fn("Edge.seed.importIssuer")(
  function* importIssuer(secret: string, pin: typeof Issuer.Type) {
    const { did, signing } = yield* Schema.decodeEffect(SigningIdentity)(
      secret
    ).pipe(
      Effect.mapError(() =>
        failure("Expected a Rat King signing identity on stdin")
      )
    );

    if (did !== pin.did || signing.x !== pin.key.x || signing.y !== pin.key.y) {
      return yield* failure(
        "Signing identity does not match the configured public issuer pin"
      );
    }

    return yield* Effect.tryPromise({
      catch: () => failure("Cannot import the issuer's P-256 signing key"),
      try: () =>
        crypto.subtle.importKey(
          "jwk",
          signing,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"]
        ),
    });
  }
);

const apex = AccountDid.make(`did:web:${identityZone}`);

export const peopleHost = `joel--people.${identityZone}`;

const peopleDid = AccountDid.make(`did:web:${peopleHost}`);

export const peopleHandle = Handle.make(`joel.people.${identityZone}`);

const documentPath = "/.well-known/did.json";

const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(Document));

const hasKey = (document: typeof Document.Type, key: typeof Key.Type) =>
  document.verificationMethod.some(
    (method) =>
      method.id.startsWith(`${document.id}#${key.purpose}-`) &&
      method.rotatedOutAt === undefined &&
      method.publicKeyMultibase === key.publicKeyMultibase
  );

const compatible = (
  document: typeof Document.Type,
  did: typeof AccountDid.Type,
  keys: readonly (typeof Key.Type)[],
  handle: typeof Handle.Type | undefined
) =>
  document.id === did &&
  (handle === undefined || document.verificationMethod.length === 0) &&
  document.verificationMethod.every((method) =>
    keys.every(
      (key) =>
        !method.id.startsWith(`${did}#${key.purpose}-`) ||
        method.publicKeyMultibase === key.publicKeyMultibase
    )
  ) &&
  document.verificationMethod.every(
    (method) => method.rotatedOutAt === undefined
  ) &&
  (handle === undefined ||
    document.alsoKnownAs.length === 0 ||
    (document.alsoKnownAs.length === 1 &&
      document.alsoKnownAs[0] === `at://${handle}`));

export const seedIdentity = Effect.fn("Edge.seed")(function* seed({
  pin,
  signingKey,
  plan,
  send,
}: {
  readonly pin: typeof Issuer.Type;
  readonly signingKey: CryptoKey;
  readonly plan: typeof SeedPlan.Type;
  readonly send: (request: Request) => Effect.Effect<Response, SeedFailure>;
}) {
  const mutate = Effect.fn("Edge.seed.mutate")(function* mutate(
    did: typeof AccountDid.Type,
    mutation: typeof Mutation.Type
  ) {
    const now = yield* Clock.currentTimeMillis;

    const payload = JSON.stringify({
      audience: apex,
      did,
      expiresAt: now + 60_000,
      issuedAt: now,
      issuer: pin.did,
      mutation,
      nonce: uuidV4Unsafe().replaceAll("-", ""),
    });

    const signature = yield* Effect.tryPromise({
      catch: () => failure("Issuer signing failed"),
      try: () =>
        crypto.subtle.sign(
          { hash: "SHA-256", name: "ECDSA" },
          signingKey,
          adminBytes(payload)
        ),
    });

    yield* send(
      new Request(`https://${identityZone}${adminPath}`, {
        body: JSON.stringify({
          payload,
          signature: Base64Url.encode(new Uint8Array(signature)),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "manual",
      })
    ).pipe(
      Effect.filterOrElse(
        (response) => response.ok,
        (response) =>
          failure(
            `${mutation._tag} for ${did} returned HTTP ${response.status}; no later mutations were attempted`
          )
      )
    );
  });

  const readDocument = Effect.fn("Edge.seed.readDocument")(
    function* readDocument(host: string) {
      const response = yield* send(
        new Request(`https://${host}${documentPath}`, { redirect: "manual" })
      );

      if (response.status === 404) {
        return Option.none<typeof Document.Type>();
      }

      if (!response.ok) {
        return yield* failure(
          `DID read for ${host} returned HTTP ${response.status}`
        );
      }

      const text = yield* Effect.tryPromise({
        catch: () => failure(`Cannot read DID document for ${host}`),
        try: () => response.text(),
      });

      return Option.some(
        yield* decodeDocument(text).pipe(
          Effect.mapError(() => failure(`Unexpected DID document for ${host}`))
        )
      );
    }
  );

  const accounts = [
    { did: apex, handle: undefined, host: identityZone, keys: plan.apexKeys },
    { did: peopleDid, handle: peopleHandle, host: peopleHost, keys: [] },
  ];

  const observed = yield* Effect.all(
    accounts.map((account) =>
      readDocument(account.host).pipe(
        Effect.map((document) => ({
          ...account,
          document: Option.getOrUndefined(document),
        }))
      )
    )
  );

  for (const { did, keys, handle, document } of observed) {
    if (
      new Set(keys.map((key) => key.purpose)).size !== keys.length ||
      new Set(keys.map((key) => key.publicKeyMultibase)).size !== keys.length
    ) {
      return yield* failure(`Duplicate key purpose or material for ${did}`);
    }

    if (document !== undefined && !compatible(document, did, keys, handle)) {
      return yield* failure(
        `Existing identity for ${did} differs from the seed plan; refusing to replace it`
      );
    }
  }

  for (const { did, keys, handle, document } of observed) {
    if (document === undefined) {
      yield* mutate(did, Mutation.cases.Register.make({}));
    }

    for (const key of keys) {
      if (document === undefined || !hasKey(document, key)) {
        yield* mutate(did, Mutation.cases.PublishKey.make({ key }));
      }
    }

    if (
      handle !== undefined &&
      (document === undefined ||
        !document.alsoKnownAs.includes(`at://${handle}`))
    ) {
      yield* mutate(did, Mutation.cases.ClaimHandle.make({ handle }));
    }
  }

  for (const { did, host, keys, handle } of accounts) {
    const document = yield* readDocument(host);

    if (
      Option.isNone(document) ||
      !compatible(document.value, did, keys, handle) ||
      !keys.every((key) => hasKey(document.value, key)) ||
      (handle !== undefined &&
        !document.value.alsoKnownAs.includes(`at://${handle}`))
    ) {
      return yield* failure(
        `DID readback does not match the seed plan for ${did}`
      );
    }
  }

  return accounts.map(({ did }) => did);
});
