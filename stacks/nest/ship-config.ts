import { Schema } from "effect";

import { AgentName } from "../../packages/ratking-client/src/name.ts";

const Text = Schema.NonEmptyString;

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

export const RestartSettings = Schema.Struct({
  backupUnit: Schema.optionalKey(Text),
  churnLimit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  dependencies: Schema.optionalKey(Schema.Array(Text)),
  lock: Text,
  marker: Text,
  noticeSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  unit: Text,
  units: Schema.NonEmptyArray(Text),
  window: Schema.optionalKey(
    Schema.Struct({
      endHourUTC: Schema.Int.check(
        Schema.isBetween({ maximum: 23, minimum: 0 })
      ),
      startHourUTC: Schema.Int.check(
        Schema.isBetween({ maximum: 23, minimum: 0 })
      ),
    })
  ),
});

export const ShipSettings = Schema.Struct({
  bot: Text,
  checkpoint: Text,
  intervalSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  keepReleases: Schema.optionalKey(Schema.Int),
  launchd: Schema.Struct({
    errorLog: Text,
    label: Text,
    node: Text,
    outputLog: Text,
    path: Text,
    pnpm: Text,
  }),
  notify: Schema.Struct({
    config: Schema.optionalKey(Text),
    directory: Text,
    from: AgentName,
    quiet: Schema.optionalKey(Schema.Array(AgentName)),
    secret: Text,
    to: Schema.NonEmptyArray(AgentName),
  }),
  receipts: Text,
  releases: Text,
  repository: Text.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u)),
  restart: RestartSettings,
  source: Text,
});

export const ShipAttempt = Schema.Struct({
  events: Text,
  override: Schema.optionalKey(Text),
  restart: RestartSettings,
  sha: Sha,
});

export type ShipSettingsValue = typeof ShipSettings.Type;

export const RestartObservation = Schema.Struct({
  durationSeconds: Schema.NullOr(Schema.Number),
  restarted: Schema.NullOr(Schema.Boolean),
});

export const RestartEvent = Schema.Struct({
  durationSeconds: Schema.Number,
  observation: Schema.optionalKey(RestartObservation),
  override: Schema.optionalKey(Text),
  phase: Schema.Literals(["requested", "completed", "deferred"]),
  reason: Schema.optionalKey(Text),
  restarted: Schema.NullOr(Schema.Boolean),
  retryAt: Schema.optionalKey(Schema.Number),
});

export const ShipReceipt = Schema.Struct({
  celldRestarted: Schema.NullOr(Schema.Boolean),
  end: Schema.Number,
  gate: Schema.optionalKey(Text),
  hold: Schema.optionalKey(Text),
  override: Schema.optionalKey(Text),
  recovered: Schema.optionalKey(Schema.Boolean),
  restartSeconds: Schema.NullOr(Schema.Number),
  result: Schema.Literals(["success", "failed", "deferred", "held"]),
  retryAt: Schema.optionalKey(Schema.Number),
  sha: Sha,
  start: Schema.Number,
  stderrTail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});

export const PreparedRetries = Schema.Record(Sha, Schema.Finite);

export const PreparedHolds = Schema.Record(
  Schema.Union([Sha, Schema.Literal("global")]),
  Text
);

export const ShipCheckpoint = Schema.Struct({
  deferred: Schema.optionalKey(Schema.Union([Schema.Literal(""), Sha])),
  failed: Schema.Union([Schema.Literal(""), Sha]),
  failedGate: Schema.optionalKey(Schema.String),
  preparedHolds: Schema.optionalKey(PreparedHolds),
  preparedRetries: Schema.optionalKey(PreparedRetries),
  retryAt: Schema.optionalKey(Schema.Number),
  successful: Schema.Union([Schema.Literal(""), Sha]),
});
