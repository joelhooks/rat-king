import { Schema } from "effect";

const Attempt = Schema.Struct({
  admissionSeq: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Finite,
  messageId: Schema.String,
});

export const PushAttempts = Schema.Record(Schema.String, Attempt);

export type PushAttemptsValue = typeof PushAttempts.Type;
