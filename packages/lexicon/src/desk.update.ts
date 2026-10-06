import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Main = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("sh.mschf.ratking.desk.update"),
    itemId: Runtime.lexString({ type: "string" }),
    project: Runtime.lexString({ type: "string" }),
    state: Runtime.lexString({
      enum: ["resolved", "superseded", "followup"],
      type: "string",
    }).pipe(
      Schema.decodeTo(Schema.Literals(["resolved", "superseded", "followup"]))
    ),
    text: Schema.optionalKey(Runtime.lexString({ type: "string" })),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const RecordMetadata = {
  collection: "sh.mschf.ratking.desk.update",
  key: "tid",
} as const;
