import { Schema } from "effect";

export class EnvelopeFailure extends Schema.TaggedError<EnvelopeFailure>()(
  "EnvelopeFailure",
  { reason: Schema.String }
) {}
