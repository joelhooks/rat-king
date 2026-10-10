import { Schema } from "effect";

const Reasoned = Schema.Struct({ reason: Schema.String });

export const reasonOf = (error: { readonly _tag: string }) =>
  Schema.is(Reasoned)(error) ? error.reason : error._tag;
