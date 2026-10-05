import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Main = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("sh.mschf.ratking.desk.theme"),
    namePool: Schema.optionalKey(
      Schema.Array(Runtime.lexString({ type: "string" })).check(
        Schema.isMinLength(0),
        Schema.isMaxLength(9_007_199_254_740_991)
      )
    ),
    tone: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    universe: Runtime.lexString({ type: "string" }),
    updatedAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const RecordMetadata = {
  collection: "sh.mschf.ratking.desk.theme",
  key: "tid",
} as const;
