import { Schema } from "effect";

export class ModelRefused extends Schema.TaggedError<ModelRefused>()(
  "ModelRefused",
  { model: Schema.String }
) {}
