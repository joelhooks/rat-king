import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Option = Schema.StructWithRest(
  Schema.Struct({
    id: Runtime.lexString({ type: "string" }),
    label: Runtime.lexString({ type: "string" }),
    outcome: Runtime.lexString({ type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OptionValue = typeof Option.Type;

export const Choice = Schema.StructWithRest(
  Schema.Struct({
    key: Runtime.lexString({ type: "string" }),
    label: Runtime.lexString({ type: "string" }),
    options: Schema.Array(Option).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(9_007_199_254_740_991)
    ),
    suggest: Runtime.lexString({ type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ChoiceValue = typeof Choice.Type;

export const Row = Schema.StructWithRest(
  Schema.Struct({
    label: Runtime.lexString({ type: "string" }),
    on: Schema.Boolean,
    v: Runtime.lexString({ type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type RowValue = typeof Row.Type;

export const Rows = Schema.StructWithRest(
  Schema.Struct({
    items: Schema.Array(Row).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(9_007_199_254_740_991)
    ),
    key: Runtime.lexString({ type: "string" }),
    label: Runtime.lexString({ type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type RowsValue = typeof Rows.Type;

export const Main = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("sh.mschf.ratking.desk.item"),
    body: Runtime.lexString({ type: "string" }),
    choices: Schema.Array(Choice).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(9_007_199_254_740_991)
    ),
    createdAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    itemId: Runtime.lexString({ type: "string" }),
    kind: Runtime.lexString({
      enum: ["decision", "approval", "blocked", "done", "fyi"],
      type: "string",
    }).pipe(
      Schema.decodeTo(
        Schema.Literals(["decision", "approval", "blocked", "done", "fyi"])
      )
    ),
    project: Runtime.lexString({ type: "string" }),
    refs: Schema.Array(Runtime.lexString({ type: "string" })).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(9_007_199_254_740_991)
    ),
    rows: Schema.optionalKey(Rows),
    supersedes: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    title: Runtime.lexString({ type: "string" }),
    why: Runtime.lexString({ type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const RecordMetadata = {
  collection: "sh.mschf.ratking.desk.item",
  key: "tid",
} as const;
