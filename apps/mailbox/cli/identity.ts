/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy WebCrypto adapter. */
import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Effect, FileSystem, Path, Schema } from "effect";

export const PrivateJwk = Schema.Struct({
  crv: Schema.Literal("P-256"),
  d: Schema.String,
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
});

export const Identity = Schema.Struct({
  agreement: PrivateJwk,
  did: Schema.String.check(Schema.isPattern(/^did:web:/u)),
  signing: PrivateJwk,
});

export type IdentityValue = typeof Identity.Type;

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  reason: Schema.String,
}) {}

export const readIdentity = Effect.fn("MailboxCli.readIdentity")(
  function* readIdentity(home: string, agent: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(agent)) {
      return yield* new CliError({ reason: "Invalid agent label" });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(home, ".config/rat-king/agents", `${agent}.jwk`);
    const stat = yield* fs.stat(file);

    if (stat.type !== "File" || stat.mode % 512 !== 0o600) {
      return yield* new CliError({
        reason: "Identity must be a regular file with mode 600",
      });
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
      yield* fs.readFileString(file)
    ).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid private identity file" })
      )
    );
  }
);

export const importSigning = (identity: IdentityValue) =>
  cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      identity.signing,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    )
  );

export const importAgreement = (identity: IdentityValue) =>
  cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      identity.agreement,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    )
  );
