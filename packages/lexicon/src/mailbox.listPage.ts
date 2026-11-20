import { Effect, Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Message = Schema.StructWithRest(
  Schema.Struct({
    admissionSeq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    envelope: Defs.EncryptedEnvelope,
    receipt: Defs.Receipt,
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MessageValue = typeof Message.Type;

export const Params = Schema.StructWithRest(
  Schema.Struct({
    afterSeq: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
    beforeSeq: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(100)
      )
    ),
    recipientDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ParamsValue = typeof Params.Type;

export const Input = Schema.Undefined;

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({
    events: Schema.Array(
      Schema.Union([
        Schema.StructWithRest(
          Schema.Struct({
            $type: Schema.Literal("sh.mschf.ratking.defs#messageEvent"),
            envelope: Defs.EncryptedEnvelope,
            receipt: Defs.Receipt,
            seq: Schema.Int.check(
              Schema.isGreaterThanOrEqualTo(1),
              Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
            ),
          }),
          [Schema.Record(Schema.String, Runtime.Data)]
        ),
        Schema.StructWithRest(
          Schema.Struct({
            $type: Schema.Literal("sh.mschf.ratking.defs#receiptEvent"),
            receipt: Defs.Receipt,
            seq: Schema.Int.check(
              Schema.isGreaterThanOrEqualTo(1),
              Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
            ),
          }),
          [Schema.Record(Schema.String, Runtime.Data)]
        ),
        Schema.StructWithRest(
          Schema.Struct({
            $type: Schema.Literal("sh.mschf.ratking.attention.receipt"),
            operation: Runtime.lexString({
              enum: ["putPreferences", "putStatus"],
              type: "string",
            }).pipe(
              Schema.decodeTo(Schema.Literals(["putPreferences", "putStatus"]))
            ),
            seq: Schema.Int.check(
              Schema.isGreaterThanOrEqualTo(1),
              Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
            ),
          }),
          [Schema.Record(Schema.String, Runtime.Data)]
        ),
        Runtime.TaggedMap.check(
          Schema.makeFilter(
            (value) =>
              ![
                "sh.mschf.ratking.defs#messageEvent",
                "sh.mschf.ratking.defs#receiptEvent",
                "sh.mschf.ratking.attention.receipt",
              ].includes(value.$type),
            { expected: "unknown union tag only" }
          )
        ),
      ])
    ).check(Schema.isMinLength(0), Schema.isMaxLength(100)),
    latestSeq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    messages: Schema.optionalKey(
      Schema.Array(Message).check(
        Schema.isMinLength(0),
        Schema.isMaxLength(100)
      )
    ),
    nextAfterSeq: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
    nextBeforeSeq: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({
    afterSeq: Schema.optionalKey(Schema.FiniteFromString),
    beforeSeq: Schema.optionalKey(Schema.FiniteFromString),
    limit: Schema.optionalKey(Schema.FiniteFromString),
    recipientDid: Schema.String,
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
).pipe(Schema.decodeTo(Params));

export const encodeParams = Effect.fn("lexicon.encodeParams")(
  function* encodeParams(params: ParamsValue) {
    return Query.entries(
      yield* Schema.decodeUnknownEffect(Query.Params)(
        yield* Schema.encodeEffect(ParamsFromQuery)(params)
      )
    );
  }
);

export const decodeParams = Effect.fn("lexicon.decodeParams")(
  function* decodeParams(entries: readonly (readonly [string, string])[]) {
    return yield* Schema.decodeUnknownEffect(ParamsFromQuery)(
      Query.parameters(entries)
    );
  }
);

export const ErrorBody = Runtime.XrpcErrorBody;

export type ErrorBodyValue = typeof ErrorBody.Type;

export const KnownErrors = [
  "InvalidRequest",
  "AuthRequired",
  "Forbidden",
  "MailboxUnavailable",
  "InvalidCursor",
] as const;

export type KnownError = (typeof KnownErrors)[number];

export const isKnownError = (value: string): value is KnownError =>
  KnownErrors.some((name) => name === value);

export const Method = {
  defaults: { limit: 50 },
  error: ErrorBody,
  input: Input,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.mailbox.listPage",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.listPage",
} as const;
