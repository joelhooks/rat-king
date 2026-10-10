import { Schema } from "effect";

import { AgentName } from "../../packages/pi-ratking/src/name.ts";

const Text = Schema.NonEmptyString;

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

export const RestartSettings = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Array(Text)),
  lock: Text,
  marker: Text,
  minIntervalHours: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
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
  retryAt: Schema.optionalKey(Schema.Number),
});

export const ShipReceipt = Schema.Struct({
  celldRestarted: Schema.NullOr(Schema.Boolean),
  end: Schema.Number,
  restartSeconds: Schema.NullOr(Schema.Number),
  result: Schema.Literals(["success", "failed", "deferred"]),
  retryAt: Schema.optionalKey(Schema.Number),
  sha: Sha,
  start: Schema.Number,
  stderrTail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});

export const ShipCheckpoint = Schema.Struct({
  deferred: Schema.optionalKey(Schema.Union([Schema.Literal(""), Sha])),
  failed: Schema.Union([Schema.Literal(""), Sha]),
  retryAt: Schema.optionalKey(Schema.Number),
  successful: Schema.Union([Schema.Literal(""), Sha]),
});
