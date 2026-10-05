import { isCid, parseCid, parseCidSafe } from "@atproto/lex-data";
import type { Cid as CidValue } from "@atproto/lex-data";
import { Lexicons } from "@atproto/lexicon";
import type { LexString } from "@atproto/lexicon";
import { Schema, SchemaGetter } from "effect";

export type LexValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CidValue
  | readonly LexValue[]
  | LexMap;

export interface LexMap {
  readonly [key: string]: LexValue;
}

export type LexJson =
  | null
  | boolean
  | number
  | string
  | readonly LexJson[]
  | LexJsonMap;

export interface LexJsonMap {
  readonly [key: string]: LexJson;
}

export const Cid = Schema.declare((value): value is CidValue =>
  isCid(value, { flavor: "dasl" })
);

const CidText = Schema.String.check(
  Schema.makeFilter(
    (value) => parseCidSafe(value, { flavor: "dasl" }) !== null,
    { expected: "CIDv1, raw or DAG-CBOR, SHA-256" }
  )
);

export const Link = Schema.StructWithRest(Schema.Struct({ $link: CidText }), [
  Schema.Record(Schema.String, Schema.String),
])
  .check(
    Schema.makeFilter((value) => Object.keys(value).length === 1, {
      expected: "one link wrapper key",
    })
  )
  .pipe(
    Schema.decodeTo(Cid, {
      decode: SchemaGetter.transform((value) =>
        parseCid(value.$link, { flavor: "dasl" })
      ),
      encode: SchemaGetter.transform((value) => ({ $link: value.toString() })),
    })
  );

export const Bytes = Schema.StructWithRest(
  Schema.Struct({ $bytes: Schema.String }),
  [Schema.Record(Schema.String, Schema.String)]
)
  .check(
    Schema.makeFilter((value) => Object.keys(value).length === 1, {
      expected: "one byte wrapper key",
    })
  )
  .pipe(Schema.decodeTo(Schema.Struct({ $bytes: Schema.Uint8ArrayFromBase64 })))
  .pipe(
    Schema.decodeTo(Schema.Uint8Array, {
      decode: SchemaGetter.transform((value) => value.$bytes),
      encode: SchemaGetter.transform((value) => ({ $bytes: value })),
    })
  );

export const Data: Schema.Codec<LexValue, LexJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Int,
    Schema.String,
    Bytes,
    Link,
    Schema.Array(Data),
    Schema.Record(Schema.String, Data).check(
      Schema.makeFilter(
        (value) => !("$bytes" in value) && !("$link" in value),
        { expected: "data map, not a malformed byte or link wrapper" }
      )
    ),
  ])
);

export const DataMap = Schema.Record(Schema.String, Data).check(
  Schema.makeFilter((value) => !("$bytes" in value) && !("$link" in value), {
    expected: "data-model map",
  })
);

export const TaggedMap = Schema.StructWithRest(
  Schema.Struct({ $type: Schema.String }),
  [Schema.Record(Schema.String, Data)]
);

export const lexString = (definition: LexString) => {
  const validators = new Lexicons([
    {
      defs: {
        main: {
          properties: { value: definition },
          required: ["value"],
          type: "object",
        },
      },
      id: "sh.mschf.ratking.lexgen",
      lexicon: 1,
    },
  ]);

  return Schema.String.check(
    Schema.makeFilter(
      (value) =>
        validators.validate("sh.mschf.ratking.lexgen", { value }).success,
      { expected: "Lexicon string constraints" }
    )
  );
};

export const Blob = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("blob"),
    mimeType: Schema.String,
    ref: Link,
    size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  [Schema.Record(Schema.String, Data)]
);

export const XrpcErrorBody = Schema.StructWithRest(
  Schema.Struct({
    error: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Data)]
);
