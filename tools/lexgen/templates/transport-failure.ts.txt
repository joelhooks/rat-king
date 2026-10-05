import { Schema } from "effect";

export class TransportFailure extends Schema.TaggedError<TransportFailure>()(
  "TransportFailure",
  { cause: Schema.Defect(), reason: Schema.String }
) {}
