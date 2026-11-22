/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { Config, Effect, Redacted, Schema } from "effect";

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  { reason: Schema.String }
) {}

const unavailable = () =>
  new CredentialError({ reason: "Systemd credential unavailable or invalid" });

export const secretSource = Config.schema(
  Schema.Literals(["agent-secrets", "systemd"]),
  "RAT_KING_SECRET_SOURCE"
).pipe(Config.withDefault("agent-secrets"));

const credentialId = /^[a-z0-9_][a-z0-9_-]*$/u;

const limit = 65_536;

const readCredential = async (file: string) => {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size < 1 || stat.size > limit) {
      throw unavailable();
    }

    const buffer = Buffer.alloc(limit + 1);
    let used = 0;

    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used
      );

      if (bytesRead === 0) {
        break;
      }

      used += bytesRead;
    }

    if (used !== stat.size) {
      throw unavailable();
    }

    return Redacted.make(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, used)
      )
    );
  } finally {
    await handle.close();
  }
};

export const systemdCredential = Effect.fn("Systemd.credential")(
  function* credential(id: string) {
    const directory = yield* Config.String("CREDENTIALS_DIRECTORY").pipe(
      Effect.mapError(unavailable)
    );

    if (!path.isAbsolute(directory) || credentialId.exec(id)?.[0] !== id) {
      return yield* unavailable();
    }

    return yield* Effect.tryPromise({
      catch: unavailable,
      try: async () => await readCredential(path.join(directory, id)),
    });
  }
);
