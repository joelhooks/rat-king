import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export class XrpcFailure extends Schema.TaggedError<XrpcFailure>()(
  "XrpcFailure",
  {
    error: Schema.String,
    message: Schema.optionalKey(Schema.String),
    response: Schema.Union([Schema.String, Runtime.DataMap]),
    status: Schema.Int,
  }
) {}
