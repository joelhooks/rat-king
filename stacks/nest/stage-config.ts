import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Schema,
  SchemaIssue,
} from "effect";

import { AlarmSettings } from "./alarm-config.ts";
import { ShipAttempt, ShipSettings } from "./ship-config.ts";

const Text = Schema.NonEmptyString;

const OptionalText = Schema.optionalKey(Text);

const OptionalBoolean = Schema.optionalKey(Schema.Boolean);

export const RuntimeConfig = Schema.Struct({
  HOME: Text,
  MODEL_GATEWAY_BASE_URL: OptionalText,
  MODEL_GATEWAY_MODEL: Schema.optionalKey(
    Schema.Literals(["gpt-6-sol", "claude-opus-5-5"])
  ),
  RATS_NEST_INSTANCE: Text,
  RAT_KING_AGENT_MODEL: Schema.Literals(["faux", "gateway"]),
  RAT_KING_AGENT_SECRET_TEMPLATE: Text.check(Schema.isPattern(/\{agent\}/u)),
  RAT_KING_BACKUP_ROOT: Text,
  RAT_KING_BUCKET: OptionalText,
  RAT_KING_CLAUDE_SIDECAR: Schema.Boolean,
  RAT_KING_CLI_OUTPUT: Text,
  RAT_KING_COMMIT: Text,
  RAT_KING_DELEGATION: OptionalBoolean,
  RAT_KING_DOCUMENTS: Text,
  RAT_KING_ENDPOINT: Text,
  RAT_KING_ISSUER_DID_TEMPLATE: OptionalText,
  RAT_KING_ISSUER_RESERVED: Schema.Array(Text),
  RAT_KING_LEASE_RESOLVERS: Schema.Array(Text),
  RAT_KING_LIVE_NODE: Text,
  RAT_KING_LOCAL_AGENT: OptionalText,
  RAT_KING_LOCAL_DID: OptionalText,
  RAT_KING_MODEL_GATEWAY_SECRET_NAME: OptionalText,
  RAT_KING_OBSERVER_DIDS: Schema.Array(Text),
  RAT_KING_OFFLINE_PLAN: OptionalBoolean,
  RAT_KING_OPERATOR_DIDS: Schema.Array(Text),
  RAT_KING_OPERATOR_IDENTITY: Text,
  RAT_KING_RECOVER_STATE: OptionalBoolean,
  RAT_KING_REMOTE_AGENT: OptionalText,
  RAT_KING_REMOTE_DID: OptionalText,
  RAT_KING_SERVICE_DID: Text,
  RAT_KING_SIDECAR_OUTPUT: OptionalText,
  RAT_KING_SLICE_MEMORY_MAX: Text,
  RAT_KING_STAGE: Schema.Literals(["proof", "pilot", "fleet"]),
  RAT_KING_START_APPROVED: OptionalBoolean,
  RAT_KING_STATE_DIR: Text,
  RAT_KING_VERSION: Text,
});

const Paths = Schema.Struct({
  quarantine: Text,
  receipts: Text,
  sessions: Text,
});

const DoctorHost = Schema.Struct({
  config: Schema.optionalKey(Text),
  node: Schema.optionalKey(Text),
});

export const StageConfig = Schema.Struct({
  alarm: Schema.optionalKey(AlarmSettings),
  comms: Schema.Struct({
    local: Paths,
    remote: Schema.Struct({ ...Paths.fields, ssh: Text }),
  }),
  doctor: Schema.optionalKey(
    Schema.Struct({
      primary: DoctorHost,
      secondary: Schema.Struct({ ...DoctorHost.fields, ssh: Text }),
    })
  ),
  mintHost: Schema.optionalKey(
    Schema.Struct({
      did: Text,
      node: Text,
      secretName: Text,
      ssh: Text,
    })
  ),
  restoreDrill: Schema.optionalKey(
    Schema.Struct({
      bucket: Text.check(
        Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u)
      ),
      celld: Text,
      knownDid: Text,
      knownName: Text,
      messageDid: Text,
      node: Text,
      receipts: Text,
      scratchParent: Text,
      weed: Text,
    })
  ),
  runtime: RuntimeConfig,
  ship: Schema.optionalKey(ShipSettings),
  shipAttempt: Schema.optionalKey(ShipAttempt),
});

export type StageConfigValue = typeof StageConfig.Type;

export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const RETIRED_KEYS: readonly {
  readonly key: string;
  readonly path: readonly string[];
}[] = [{ key: "minIntervalHours", path: ["ship", "restart"] }];

const JsonObject = Schema.Record(Schema.String, Schema.Json);

export type JsonDocument = typeof JsonObject.Type;

const asNode = Schema.decodeUnknownOption(JsonObject);

const dropKey = (
  node: JsonDocument,
  path: readonly string[],
  key: string
): Option.Option<JsonDocument> => {
  const [head, ...rest] = path;

  if (head === undefined) {
    return key in node
      ? Option.some(
          Object.fromEntries(
            Object.entries(node).filter(([name]) => name !== key)
          )
        )
      : Option.none();
  }

  return Option.fromNullishOr(node[head]).pipe(
    Option.flatMap(asNode),
    Option.flatMap((child) => dropKey(child, rest, key)),
    Option.map((next) => ({ ...node, [head]: next }))
  );
};

export const dropRetiredKeys = (document: JsonDocument) => {
  const retired: string[] = [];
  let value = document;

  for (const { key, path } of RETIRED_KEYS) {
    const dropped = dropKey(value, path, key);

    if (Option.isSome(dropped)) {
      retired.push([...path, key].join("."));
      ({ value } = dropped);
    }
  }

  return { retired, value };
};

const formatIssue = SchemaIssue.makeFormatterDefault();

export const causeDetail = (cause: { readonly _tag: string }): string =>
  Schema.isSchemaError(cause)
    ? formatIssue(cause.issue).replaceAll(/\s*\n\s*/gu, " ")
    : cause._tag;

const invalid = (cause: { readonly _tag: string }) =>
  new FleetError({
    reason: `Invalid stage configuration: ${causeDetail(cause)}`,
  });

export const loadStageConfig = Effect.gen(function* loadStageConfig() {
  const location = yield* Config.String("RAT_KING_STAGE_CONFIG");
  const fs = yield* FileSystem.FileSystem;

  const document = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(JsonObject)
  )(yield* fs.readFileString(location)).pipe(Effect.mapError(invalid));

  const { retired, value } = dropRetiredKeys(document);

  for (const key of retired) {
    yield* Effect.logWarning(
      `Stage configuration key ${key} is retired and ignored; remove ${key} from the stage file`
    );
  }

  return yield* Schema.decodeUnknownEffect(StageConfig)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(invalid));
});

export const stageProvider = (config: StageConfigValue) =>
  ConfigProvider.fromUnknown({
    ...config.runtime,
    ALCHEMY_TELEMETRY_DISABLED: "1",
    RAT_KING_ISSUER_RESERVED: JSON.stringify(
      config.runtime.RAT_KING_ISSUER_RESERVED
    ),
    RAT_KING_LEASE_RESOLVERS: JSON.stringify(
      config.runtime.RAT_KING_LEASE_RESOLVERS
    ),
    RAT_KING_OBSERVER_DIDS: JSON.stringify(
      config.runtime.RAT_KING_OBSERVER_DIDS
    ),
    RAT_KING_OPERATOR_DIDS: JSON.stringify(
      config.runtime.RAT_KING_OPERATOR_DIDS
    ),
    RAT_KING_SHIP_ATTEMPT:
      config.shipAttempt === undefined
        ? undefined
        : JSON.stringify(config.shipAttempt),
    RAT_KING_SHIP_CONFIG:
      config.shipAttempt === undefined ? undefined : JSON.stringify(config),
    RAT_KING_SHIP_MODE: config.shipAttempt !== undefined,
  });
