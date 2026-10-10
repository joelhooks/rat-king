/* oxlint-disable eslint/max-classes-per-file -- Effect service and Schema contracts share their owning port. */
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import { Did, Reserved } from "./name.ts";
import type { ReservedValue } from "./name.ts";

export const ToolName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/u)
);

export const PiConfig = Schema.Struct({
  askTimeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  didTemplate: Schema.String.check(
    Schema.isPattern(/^did:web:[^#{}\s]*\{agent\}[^#{}\s]*$/u)
  ),
  directory: Schema.optionalKey(Schema.String),
  documents: Schema.optionalKey(Schema.Array(Schema.String)),
  endpoint: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u)),
  issuer: Schema.optionalKey(
    Schema.Struct({ command: Schema.NonEmptyArray(Schema.String) })
  ),
  reserved: Schema.optionalKey(Reserved),
  secretsCommand: Schema.optionalKey(Schema.String),
  serviceDid: Did,
  state: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(ToolName),
});

export type PiConfigValue = typeof PiConfig.Type;

export interface SettingsValue {
  readonly askTimeoutMs: number;
  readonly didTemplate: string;
  readonly directory: string;
  readonly documents: readonly string[];
  readonly endpoint: string;
  readonly issuer: Option.Option<readonly string[]>;
  readonly reserved: ReservedValue;
  readonly secretsCommand: string;
  readonly serviceDid: string;
  readonly state: string;
}

export class Settings extends Context.Service<Settings, SettingsValue>()(
  "pi-ratking/Settings"
) {}

export class NotConfigured extends Schema.TaggedError<NotConfigured>()(
  "NotConfigured",
  { reason: Schema.String }
) {}

const notConfigured = (reason: string) => () => new NotConfigured({ reason });

const readConfig = Effect.fn("RatKing.readConfig")(function* readConfig() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const home = yield* Config.String("HOME").pipe(
    Effect.mapError(notConfigured("HOME is unset"))
  );

  const file = Option.getOrElse(
    yield* Config.option(Config.String("RATKING_CONFIG")).pipe(
      Effect.mapError(notConfigured("RATKING_CONFIG is unreadable"))
    ),
    () => path.join(home, ".config/rat-king/pi.json")
  );

  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(notConfigured(`No Rat King config at ${file}`)));

  const config = yield* Schema.decodeEffect(Schema.fromJsonString(PiConfig))(
    text
  ).pipe(
    Effect.mapError(notConfigured(`Malformed Rat King config at ${file}`))
  );

  return { config, home };
});

export const toolName = Effect.gen(function* resolveToolName() {
  const env = yield* Config.option(Config.schema(ToolName, "RATKING_TOOL"));

  if (Option.isSome(env)) {
    return env.value;
  }

  const configured = yield* readConfig().pipe(Effect.option);

  return Option.match(
    Option.flatMapNullishOr(configured, ({ config }) => config.toolName),
    { onNone: () => "ratking", onSome: (name) => name }
  );
}).pipe(Effect.orElseSucceed(() => "ratking"));

export const loadSettings = Effect.fn("RatKing.loadSettings")(
  function* loadSettings() {
    const path = yield* Path.Path;
    const { config, home } = yield* readConfig();
    const state = config.state ?? path.join(home, ".local/state/rat-king/pi");

    return Settings.of({
      askTimeoutMs: config.askTimeoutMs ?? 600_000,
      didTemplate: config.didTemplate,
      directory: config.directory ?? path.join(state, "directory.json"),
      documents: config.documents ?? [],
      endpoint: config.endpoint,
      issuer: Option.fromNullishOr(config.issuer?.command),
      reserved: config.reserved ?? {},
      secretsCommand: config.secretsCommand ?? "secrets",
      serviceDid: config.serviceDid,
      state,
    });
  }
);

export const settingsLayer = Layer.effect(Settings, loadSettings());
