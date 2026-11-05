import { Schema } from "effect";

import { Digest } from "./health.ts";

export const FailedHealth = Schema.Struct({
  reasons: Schema.Array(Schema.String),
  status: Schema.Literal("fail"),
});

export const FleetDigest = Schema.Struct({
  at: Schema.String,
  comms: Schema.Struct({
    failed_intercom_24h: Schema.optionalKey(Schema.Int),
    fallbacks_24h: Schema.Int,
    lost_24h: Schema.Int,
    quarantined_24h: Schema.Int,
    raw_intercom_24h: Schema.Int,
    sent_24h: Schema.Int,
    unanswered_24h: Schema.optionalKey(Schema.Int),
  }),
  rat_king: Schema.Union([Digest, FailedHealth]),
  reasons: Schema.Array(Schema.String),
  status: Schema.Literals(["ok", "warn", "fail"]),
  waitingMail: Schema.optionalKey(Schema.Array(Schema.String)),
});
