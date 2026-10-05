/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Private WebCrypto generation stays on the agent's machine. */
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Effect, FileSystem, Path, Schema } from "effect";

import { Documents } from "../src/auth.ts";
import { CliError, Identity, PrivateJwk, readIdentity } from "./identity.ts";
import type { IdentityValue } from "./identity.ts";

const Pair = Schema.Struct({
  privateKey: Schema.instanceOf(CryptoKey),
  publicKey: Schema.instanceOf(CryptoKey),
});

const generateKey = Effect.fn("MailboxCli.generateKey")(function* generateKey(
  name: "ECDSA" | "ECDH"
) {
  const key = yield* cryptoOperation(() =>
    crypto.subtle.generateKey(
      { name, namedCurve: "P-256" },
      true,
      name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"]
    )
  );

  const pair = yield* Schema.decodeUnknownEffect(Pair)(key);

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

export const publicDocument = (identity: IdentityValue) => ({
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

export const provision = Effect.fn("MailboxCli.provision")(function* provision(
  home: string,
  agent: string,
  did: string
) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(agent)) {
    return yield* new CliError({ reason: "Invalid agent label" });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".config/rat-king/agents");
  const file = path.join(directory, `${agent}.jwk`);

  if (!(yield* fs.exists(file))) {
    const identity = yield* Schema.decodeUnknownEffect(Identity)({
      agreement: yield* generateKey("ECDH"),
      did,
      signing: yield* generateKey("ECDSA"),
    });

    yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(identity), {
      flag: "wx",
      mode: 0o600,
    });
  }

  const identity = yield* readIdentity(home, agent);

  if (identity.did !== did) {
    return yield* new CliError({
      reason: "Existing identity has a different DID; never replacing keys",
    });
  }

  const docs = yield* Schema.decodeUnknownEffect(Documents)([
    publicDocument(identity),
  ]);

  return docs[0];
});
