import { Schema } from "effect";

export class TestFailure extends Schema.TaggedError<TestFailure>()(
  "TestFailure",
  {
    message: Schema.String,
  }
) {}
