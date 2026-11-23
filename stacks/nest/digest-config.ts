import { Schema } from "effect";

import { AlarmSourcesOff } from "./alarm-config.ts";
import { Digest } from "./health.ts";

export const FailedHealth = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  status: Schema.Literal("fail"),
});

export const FleetDigest = Schema.Struct({
  alarmSources: Schema.optionalKey(AlarmSourcesOff),
  at: Schema.String,
  comms: Schema.Struct({
    fallbacks_24h: Schema.Int,
    lost_24h: Schema.Int,
    quarantined_24h: Schema.NullOr(Schema.Int),
    sent_24h: Schema.Int,
  }),
  doctorUnavailableCount: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  rat_king: Schema.Union([Digest, FailedHealth]),
  reasons: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "warn", "fail"]),
  waitingMail: Schema.optionalKey(Schema.Array(Schema.String)),
});
