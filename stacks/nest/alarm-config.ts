import { Schema } from "effect";

import { AgentName } from "../../packages/pi-ratking/src/name.ts";

export const AlarmKey = Schema.Literals([
  "ship.failed",
  "celld.down",
  "celld.restarted",
  "issuer.broken",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
]);

export type AlarmKeyValue = typeof AlarmKey.Type;

export const AlarmSettings = Schema.Struct({
  broadcast: AgentName,
  enabled: Schema.Boolean,
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
  readers: Schema.Array(
    Schema.Struct({
      aliveCommand: Schema.NonEmptyArray(Schema.NonEmptyString),
      name: AgentName,
    })
  ),
  renotifyMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
});

export type AlarmSettingsValue = typeof AlarmSettings.Type;

export const Severity = Schema.Literals(["warn", "critical"]);

export const AlarmReading = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({
    evidence: Schema.String,
    severity: Severity,
    status: Schema.Literal("firing"),
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
  "ship.failed",
  "celld.down",
  "celld.restarted",
  "issuer.broken",
  "readers.stuck",
  "filer.slots",
  "quarantine.growth",
  "digest.fail",
];
