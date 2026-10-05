import { Schema } from "effect";

export class HarnessFailure extends Schema.TaggedError<HarnessFailure>()(
  "HarnessFailure",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}
