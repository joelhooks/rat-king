import { Schema } from "effect";

import { AgentName } from "../../packages/ratking-client/src/name.ts";

export const AlarmKey = Schema.Literals([
  "wake.unacked",
  "ship.failed",
  "ship.churn",
  "celld.down",
  "celld.restarted",
  "issuer.broken",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
  "cache.rewrites",
  "instance.down",
  "backup.sessions-index",
  "recall.flowing-canary",
]);

export type AlarmKeyValue = typeof AlarmKey.Type;

const IgnoredAliveProbe = Schema.Struct({
  aliveCommand: Schema.NonEmptyArray(Schema.NonEmptyString),
  name: AgentName,
});

export const ConfiguredWakeTarget = Schema.Struct({
  name: AgentName,
  owner: AgentName,
  page: Schema.optionalKey(Schema.Boolean),
  unackedMinutes: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0))
  ),
});

export const AlarmSettings = Schema.Struct({
  broadcast: AgentName,
  cacheHealth: Schema.optionalKey(Schema.NonEmptyString),
  enabled: Schema.Boolean,
  instances: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        owner: AgentName,
        page: Schema.optionalKey(Schema.Boolean),
        versionUrl: Schema.NonEmptyString,
      })
    )
  ),
  launchd: Schema.Struct({
    errorLog: Schema.NonEmptyString,
    label: Schema.NonEmptyString,
    node: Schema.NonEmptyString,
    outputLog: Schema.NonEmptyString,
    path: Schema.NonEmptyString,
    source: Schema.NonEmptyString,
  }),
  musterDesk: AgentName,
  notify: Schema.Struct({
    config: Schema.optionalKey(Schema.NonEmptyString),
    directory: Schema.NonEmptyString,
    secret: Schema.NonEmptyString,
  }),
  owners: Schema.Record(Schema.NonEmptyString, AgentName),
  page: Schema.Struct({
    node: Schema.NonEmptyString,
    script: Schema.NonEmptyString,
  }),
  readerHeartbeats: Schema.optionalKey(
    Schema.NonEmptyArray(
      Schema.Struct({
        dir: Schema.NonEmptyString,
        host: Schema.NonEmptyString,
        ssh: Schema.optionalKey(Schema.NonEmptyString),
      })
    )
  ),
  readers: Schema.optionalKey(Schema.Array(IgnoredAliveProbe)),
  recallCanary: Schema.optionalKey(
    Schema.Struct({
      alarmFile: Schema.NonEmptyString,
      receipt: Schema.NonEmptyString,
    })
  ),
  renotifyMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  sessionsBackup: Schema.optionalKey(
    Schema.Struct({
      alarmFile: Schema.NonEmptyString,
      receipt: Schema.NonEmptyString,
    })
  ),
  turnRecords: Schema.optionalKey(Schema.Boolean),
  wakeTargets: Schema.optionalKey(Schema.Array(ConfiguredWakeTarget)),
  wakeUnackedMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0))
  ),
});

export type AlarmSettingsValue = typeof AlarmSettings.Type;

export const Severity = Schema.Literals(["warn", "critical"]);

export const AlarmReading = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({
    evidence: Schema.String,
    recipients: Schema.optionalKey(Schema.Array(AgentName)),
    severity: Severity,
    status: Schema.Literal("firing"),
  }),
  Schema.Struct({
    evidence: Schema.String,
    recipients: Schema.Array(AgentName),
    status: Schema.Literal("maintenance"),
    windows: Schema.Array(Schema.String),
  }),
]);

export type AlarmReadingValue = typeof AlarmReading.Type;

export const AlarmContext = Schema.Struct({
  lastSent: Schema.Finite,
  severity: Severity,
  since: Schema.Finite,
});

export const AlarmState = Schema.Struct({
  context: AlarmContext,
  value: Schema.Literals(["ok", "firing", "recovered"]),
});

export type AlarmStateValue = typeof AlarmState.Type;

export const alarmKeys: readonly AlarmKeyValue[] = [
  "wake.unacked",
  "ship.failed",
  "ship.churn",
  "celld.down",
  "celld.restarted",
  "issuer.broken",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
  "cache.rewrites",
  "instance.down",
  "backup.sessions-index",
  "recall.flowing-canary",
];
