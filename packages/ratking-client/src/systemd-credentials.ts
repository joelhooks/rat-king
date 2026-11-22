/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off
import { constants } from "node:fs";
import { open, stat as fileStat } from "node:fs/promises";
import path from "node:path";

import {
  Config,
  ConfigProvider,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect";

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  { kind: Schema.Literals(["absent", "invalid"]), reason: Schema.String }
) {}

const unavailable = () =>
  new CredentialError({
    kind: "invalid",
    reason: "Systemd credential unavailable or invalid",
  });

const absent = () =>
  new CredentialError({
    kind: "absent",
    reason: "Systemd credential slot is absent",
  });

const NotFound = Schema.Struct({ code: Schema.Literal("ENOENT") });

export const SecretSourceMode = Schema.Literals(["agent-secrets", "systemd"]);

export const secretSource = Config.schema(
  SecretSourceMode,
  "RAT_KING_SECRET_SOURCE"
).pipe(Config.withDefault("agent-secrets"));

export const credentialEnvironment = (env: {
  readonly CREDENTIALS_DIRECTORY?: string | undefined;
  readonly RAT_KING_SECRET_SOURCE?: string | undefined;
}) => {
  const selected: Record<string, string> = {};

  if (env.CREDENTIALS_DIRECTORY !== undefined) {
    selected.CREDENTIALS_DIRECTORY = env.CREDENTIALS_DIRECTORY;
  }

  if (env.RAT_KING_SECRET_SOURCE !== undefined) {
    selected.RAT_KING_SECRET_SOURCE = env.RAT_KING_SECRET_SOURCE;
  }

  return selected;
};

export const credentialProvider = (
  env: Parameters<typeof credentialEnvironment>[0]
) =>
  ConfigProvider.fromUnknown(credentialEnvironment(env)).pipe(
    ConfigProvider.orElse(ConfigProvider.fromEnv())
  );

export const readCredentialEnvironment = Effect.gen(
  function* credentialSettings() {
    const directory = yield* Config.option(
      Config.String("CREDENTIALS_DIRECTORY")
    );

    const source = yield* Config.option(
      Config.String("RAT_KING_SECRET_SOURCE")
    );

    return credentialEnvironment({
      CREDENTIALS_DIRECTORY: Option.getOrUndefined(directory),
      RAT_KING_SECRET_SOURCE: Option.getOrUndefined(source),
    });
  }
);

export const withCredentialSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settings: Readonly<Record<string, string | undefined>>
) =>
  Effect.gen(function* credentialSettings() {
    const inherited = yield* readCredentialEnvironment;
    const provider = ConfigProvider.fromUnknown({ ...settings, ...inherited });

    return yield* effect.pipe(Effect.provide(ConfigProvider.layer(provider)));
  });

const credentialId = /^[a-z0-9_][a-z0-9_-]*$/u;

const limit = 65_536;

const readCredential = async (directory: string, id: string) => {
  const info = await fileStat(directory);

  if (!info.isDirectory()) {
    throw unavailable();
  }

  const handle = await open(
    path.join(directory, id),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    throw Schema.is(NotFound)(error) ? absent() : unavailable();
  });

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
      catch: (error) =>
        Schema.is(CredentialError)(error) ? error : unavailable(),
      try: async () => await readCredential(directory, id),
    });
  }
);
