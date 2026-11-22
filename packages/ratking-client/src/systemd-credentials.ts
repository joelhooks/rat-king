import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Path,
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

export const CredentialSlot = Schema.String.check(
  Schema.isPattern(credentialId),
  Schema.makeFilter(
    (value) =>
      credentialId.exec(value)?.[0] === value ||
      "Expected a systemd credential slot identifier"
  )
);

const limit = 65_536;

const readable = (stat: FileSystem.File.Info) =>
  stat.type === "File" && stat.size > 0n && stat.size <= BigInt(limit);

export const systemdCredential = Effect.fn("Systemd.credential")(
  function* credential(id: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const directory = yield* Config.String("CREDENTIALS_DIRECTORY").pipe(
      Effect.mapError(unavailable)
    );

    if (!path.isAbsolute(directory) || !Schema.is(CredentialSlot)(id)) {
      return yield* unavailable();
    }

    if ((yield* fs.lstat(directory)).type !== "Directory") {
      return yield* unavailable();
    }

    const file = path.join(directory, id);

    const listed = yield* fs
      .lstat(file)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(absent())
        )
      );

    if (!readable(listed)) {
      return yield* unavailable();
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const actual = yield* handle.stat;

    if (!readable(actual)) {
      return yield* unavailable();
    }

    const bytes = yield* handle.readAlloc(limit + 1);

    if (
      Option.isNone(bytes) ||
      bytes.value.byteLength !== Number(actual.size)
    ) {
      return yield* unavailable();
    }

    const decoded = yield* Effect.try({
      catch: unavailable,
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.value
        ),
    });

    const ending = decoded.endsWith("\r\n")
      ? 2
      : Number(decoded.endsWith("\n"));

    const text = decoded.slice(0, decoded.length - ending);

    if (text.length === 0) {
      return yield* unavailable();
    }

    return Redacted.make(text);
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.provide([NodeFileSystem.layer, NodePath.layer]),
      Effect.catchTag("PlatformError", () => Effect.fail(unavailable()))
    )
);
