import { Config, Effect, FileSystem, Path, Redacted, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";

const PrivateKey = Schema.Struct({
  crv: Schema.Literal("P-256"),
  d: Schema.NonEmptyString,
  kty: Schema.Literal("EC"),
  x: Schema.NonEmptyString,
  y: Schema.NonEmptyString,
});

const Identity = Schema.Struct({
  agreement: PrivateKey,
  did: Schema.String,
  signing: PrivateKey,
});

export const assertFaux = (environment: NodeJS.ProcessEnv) => {
  if (
    (environment.RAT_KING_AGENT_MODEL ?? "faux") !== "faux" ||
    Object.keys(environment).some((key) => key.startsWith("MODEL_GATEWAY_")) ||
    environment.RAT_KING_CLAUDE_SIDECAR === "true"
  ) {
    throw new Error("Preview forbids gateway and sidecar inputs");
  }
};

export const externalFile = Effect.fn("Preview.externalFile")(
  function* externalFile(file: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
    const canonical = yield* fs.realPath(path.resolve(file));

    if (canonical === root || canonical.startsWith(`${root}/`)) {
      return yield* refuse("Private inputs must remain outside the repository");
    }

    return canonical;
  }
);

export const readIdentity = Effect.fn("Preview.readIdentity")(
  function* readIdentity(did: string) {
    const fs = yield* FileSystem.FileSystem;

    const file = yield* externalFile(
      yield* Config.String("RAT_KING_CF_IDENTITY_FILE")
    );

    const stat = yield* fs.stat(file);

    if (stat.type !== "File" || stat.mode % 0o1000 !== 0o600) {
      return yield* refuse("Identity requires a mode-600 private file");
    }

    const text = yield* fs.readFileString(file);

    const identity = yield* Schema.decodeEffect(
      Schema.fromJsonString(Identity)
    )(text).pipe(Effect.mapError(() => refuse("Invalid private identity")));

    if (identity.did !== did) {
      return yield* refuse("Hosted identity DID mismatch");
    }

    return Redacted.make(JSON.stringify([identity]));
  }
);
