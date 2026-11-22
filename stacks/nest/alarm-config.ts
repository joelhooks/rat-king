import { Schema } from "effect";

import { SecretName } from "../../packages/alchemy-nest/src/secret-source.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";

export const ISSUER_FAILURE_CHECKS = 3;

export const ISSUER_FAILURE_SPAN_MS = 120_000;

export const DOCTOR_UNAVAILABLE_SPAN_MS = 900_000;

export const INSTANCE_DOWN_CHECKS = 2;

const FixedAlarmKey = Schema.Literals([
  "wake.unacked",
  "ship.failed",
  "ship.churn",
  "celld.down",
  "celld.restarted",
  "issuer.broken",
  "doctor.unavailable",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
  "cache.rewrites",
  "instance.down",
  "backup.sessions-index",
  "recall.flowing-canary",
]);

export const AlarmKey = Schema.Union([
  FixedAlarmKey,
  Schema.TemplateLiteral(["mail.stranded/", AgentName]),
  Schema.TemplateLiteral(["mail.owner/", AgentName]),
  Schema.TemplateLiteral(["mail.wake/", AgentName]),
  Schema.TemplateLiteral(["reader.absent/", AgentName]),
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

const LaunchdAlarm = Schema.Struct({
  errorLog: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  node: Schema.NonEmptyString,
  outputLog: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
});

const SystemdPath = Schema.NonEmptyString.check(
  Schema.isPattern(/^\/.*[^\s\\]$|^\/$/u),
  Schema.makeFilter(
    (value) =>
      !/\p{Cc}/u.test(value) ||
      "expected an absolute path without control characters"
  )
);

const SystemdAlarm = Schema.Struct({
  errorLog: SystemdPath,
  node: SystemdPath,
  outputLog: SystemdPath,
  path: Schema.NonEmptyString,
  source: SystemdPath,
  unit: Schema.NonEmptyString.check(
    Schema.isPattern(/^[A-Za-z0-9_.-]+\.service$/u)
  ),
});

export const ConfiguredWakeTargets = Schema.optionalKey(
  Schema.Array(ConfiguredWakeTarget)
);

const AlarmCommon = Schema.Struct({
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
  push: Schema.optionalKey(
    Schema.Struct({
      names: Schema.NonEmptyArray(AgentName),
      secret: SecretName,
    })
  ),
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
  wakeOnMail: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: AgentName, waker: Schema.optionalKey(AgentName) })
    )
  ),
  wakeTargets: ConfiguredWakeTargets,
  wakeUnackedMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0))
  ),
});

export const LaunchdAlarmSettings = Schema.Struct({
  ...AlarmCommon.fields,
  launchd: LaunchdAlarm,
  systemd: Schema.optionalKey(Schema.Never),
});

export const SystemdAlarmSettings = Schema.Struct({
  ...AlarmCommon.fields,
  launchd: Schema.optionalKey(Schema.Never),
  systemd: SystemdAlarm,
});

export const AlarmSettings = Schema.Union([
  LaunchdAlarmSettings,
  SystemdAlarmSettings,
]);

export type AlarmSettingsValue = typeof AlarmSettings.Type;

export const Severity = Schema.Literals(["warn", "critical"]);

export const AlarmReading = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({
    evidence: Schema.optionalKey(Schema.String),
    status: Schema.Literal("unknown"),
  }),
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
  "doctor.unavailable",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
  "cache.rewrites",
  "instance.down",
  "backup.sessions-index",
  "recall.flowing-canary",
];
