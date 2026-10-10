import { Schema } from "effect";

import { AgentName } from "../../packages/pi-ratking/src/name.ts";

const Text = Schema.NonEmptyString;

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

export const RestartSettings = Schema.Struct({
  lock: Text,
  marker: Text,
  unit: Text,
  units: Schema.NonEmptyArray(Text),
});

export const ShipSettings = Schema.Struct({
  bot: Text,
  checkpoint: Text,
  intervalSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  launchd: Schema.Struct({
    errorLog: Text,
    label: Text,
    node: Text,
    outputLog: Text,
    path: Text,
    pnpm: Text,
  }),
  notify: Schema.Struct({
    directory: Text,
    from: AgentName,
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
  restart: RestartSettings,
  sha: Sha,
});

export type ShipSettingsValue = typeof ShipSettings.Type;

export const RestartEvent = Schema.Struct({
  durationSeconds: Schema.Number,
  phase: Schema.Literals(["requested", "completed", "deferred"]),
  restarted: Schema.NullOr(Schema.Boolean),
});

export const ShipReceipt = Schema.Struct({
  celldRestarted: Schema.NullOr(Schema.Boolean),
  end: Schema.Number,
  restartSeconds: Schema.NullOr(Schema.Number),
  result: Schema.Literals(["success", "failed", "deferred"]),
  sha: Sha,
  start: Schema.Number,
});

export const ShipCheckpoint = Schema.Struct({
  failed: Schema.Union([Schema.Literal(""), Sha]),
  successful: Schema.Union([Schema.Literal(""), Sha]),
});
