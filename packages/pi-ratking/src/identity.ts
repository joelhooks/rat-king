/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Private WebCrypto generation stays on this host. */
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Identity, PrivateJwk } from "@rat-king/mailbox-client";
import type { IdentityValue, PeerDocument } from "@rat-king/mailbox-client";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
} from "effect";

import { Settings } from "./config.ts";
import { Directory, writePrivateJson } from "./directory.ts";
import { reasonOf } from "./errors.ts";
import { Issuer } from "./issuer.ts";
import { withLock } from "./lock.ts";
import {
  AgentName,
  deriveName,
  didFor,
  isReserved,
  secretName,
} from "./name.ts";
import type { OwnName } from "./name.ts";
import { SecretStore } from "./secrets.ts";

export class IdentityError extends Schema.TaggedError<IdentityError>()(
  "IdentityError",
  { reason: Schema.String }
) {}

export interface SessionFacts {
  readonly session: string;
  readonly pid: number;
  readonly env: Option.Option<string>;
  readonly pane: Option.Option<string>;
  readonly alive: (pid: number) => boolean;
}

const Claims = Schema.Record(
  AgentName,
  Schema.Struct({ pid: Schema.Int, session: Schema.String })
);

const Pair = Schema.Struct({
  privateKey: Schema.instanceOf(CryptoKey),
  publicKey: Schema.instanceOf(CryptoKey),
});

const generateKey = Effect.fn("RatKing.generateKey")(function* generateKey(
  name: "ECDSA" | "ECDH"
) {
  const key = yield* cryptoOperation(() =>
    crypto.subtle.generateKey(
      { name, namedCurve: "P-256" },
      true,
      name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"]
    )
  );

  const pair = yield* Schema.decodeEffect(Pair)(key);

  return yield* Schema.decodeUnknownEffect(PrivateJwk)(
    yield* cryptoOperation(() =>
      crypto.subtle.exportKey("jwk", pair.privateKey)
    )
  );
});

const publicKey = (key: typeof PrivateJwk.Type) => ({
  crv: key.crv,
  kty: key.kty,
  x: key.x,
  y: key.y,
});

export const publicDocument = (identity: IdentityValue): PeerDocument => ({
  authentication: [`${identity.did}#atproto`],
  id: identity.did,
  keyAgreement: [`${identity.did}#encryption`],
  verificationMethod: [
    {
      controller: identity.did,
      id: `${identity.did}#atproto`,
      publicKeyJwk: publicKey(identity.signing),
    },
    {
      controller: identity.did,
      id: `${identity.did}#encryption`,
      publicKeyJwk: publicKey(identity.agreement),
    },
  ],
});

const fail = (reason: string) => new IdentityError({ reason });

export const claimName = Effect.fn("RatKing.claimName")(function* claimName(
  facts: SessionFacts
) {
  const settings = yield* Settings;
  const directory = yield* Directory;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(settings.state, "claims.json");

  return yield* withLock(
    path.join(settings.state, "locks"),
    "names",
    Effect.gen(function* claim() {
      const claims = yield* fs.readFileString(file).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Claims))
        ),
        Effect.orElseSucceed((): typeof Claims.Type => ({}))
      );

      const known = new Set((yield* directory.list).map((entry) => entry.name));

      const taken = (name: string) => {
        const holder = claims[name];

        return holder === undefined
          ? known.has(name)
          : holder.session !== facts.session && facts.alive(holder.pid);
      };

      const own: OwnName = yield* Result.match(
        deriveName({
          env: facts.env,
          pane: facts.pane,
          reserved: settings.reserved,
          session: facts.session,
          taken,
        }),
        {
          onFailure: (error) => Effect.fail(fail(error.reason)),
          onSuccess: Effect.succeed,
        }
      );

      if (own.source !== "env") {
        yield* writePrivateJson(
          file,
          yield* Schema.encodeEffect(Schema.fromJsonString(Claims))({
            ...claims,
            [own.name]: { pid: facts.pid, session: facts.session },
          })
        );
      }

      return own;
    })
  ).pipe(
    Effect.mapError((error) =>
      Schema.is(IdentityError)(error) ? error : fail("Name claim failed")
    )
  );
});

export const ensureIdentity = Effect.fn("RatKing.ensureIdentity")(
  function* ensureIdentity(name: string) {
    const settings = yield* Settings;
    const store = yield* SecretStore;
    const issuer = yield* Issuer;
    const directory = yield* Directory;
    const path = yield* Path.Path;
    const secret = secretName(name);
    const reserved = isReserved(settings.reserved, name);

    return yield* withLock(
      path.join(settings.state, "locks"),
      "provision",
      Effect.gen(function* provision() {
        const listed = yield* directory.resolve(name).pipe(Effect.option);

        if (yield* store.exists(secret)) {
          const identity = yield* Schema.decodeEffect(
            Schema.fromJsonString(Identity)
          )(Redacted.value(yield* store.lease(secret))).pipe(
            Effect.mapError(() => fail("Identity secret is malformed"))
          );

          const registered = Option.exists(
            listed,
            (entry) => entry.did === identity.did
          );

          if (Option.isSome(listed) && !registered) {
            return yield* fail(
              `Name ${name} is bound to another identity; keys not used`
            );
          }

          if (!reserved && !registered) {
            yield* issuer.ensure(name, publicDocument(identity));
          }

          return identity;
        }

        if (reserved) {
          return yield* fail(
            `Reserved name ${name} has no identity secret on this host; reserved names are never minted`
          );
        }

        if (Option.isSome(listed)) {
          return yield* fail(
            `Name ${name} already has an identity elsewhere; not minting`
          );
        }

        const identity = yield* Schema.decodeEffect(Identity)({
          agreement: yield* generateKey("ECDH"),
          did: didFor(settings.didTemplate, settings.reserved, name),
          signing: yield* generateKey("ECDSA"),
        }).pipe(Effect.mapError(() => fail("Generated identity is invalid")));

        yield* store.add(secret, Redacted.make(JSON.stringify(identity)));
        yield* issuer.ensure(name, publicDocument(identity));

        return identity;
      })
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(IdentityError)(error) ? error : fail(reasonOf(error))
      )
    );
  }
);
