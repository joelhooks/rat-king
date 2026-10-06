import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Main = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("sh.mschf.ratking.desk.answer"),
    inReplyTo: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    itemId: Runtime.lexString({ type: "string" }),
    note: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    project: Runtime.lexString({ type: "string" }),
    rows: Schema.optionalKey(Runtime.DataMap),
    values: Runtime.DataMap,
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const RecordMetadata = {
  collection: "sh.mschf.ratking.desk.answer",
  key: "tid",
} as const;
