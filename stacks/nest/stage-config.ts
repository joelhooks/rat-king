import { Config, ConfigProvider, Effect, FileSystem, Schema } from "effect";

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

export const StageConfig = Schema.Struct({
  comms: Schema.Struct({
    local: Paths,
    remote: Schema.Struct({ ...Paths.fields, ssh: Text }),
  }),
  mintHost: Schema.optionalKey(
    Schema.Struct({
      did: Text,
      node: Text,
      secretName: Text,
      ssh: Text,
    })
  ),
  runtime: RuntimeConfig,
});

export type StageConfigValue = typeof StageConfig.Type;

export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  reason: Schema.String,
}) {}

export const loadStageConfig = Effect.gen(function* loadStageConfig() {
  const location = yield* Config.String("RAT_KING_STAGE_CONFIG");
  const fs = yield* FileSystem.FileSystem;

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StageConfig))(
    yield* fs.readFileString(location),
    { onExcessProperty: "error" }
  ).pipe(
    Effect.mapError(
      () => new FleetError({ reason: "Invalid stage configuration" })
    )
  );
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
  });
