import { Effect, Schema } from "effect";

import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Notice = Schema.StructWithRest(
  Schema.Struct({
    admissionSeq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    body: Runtime.lexString({ maxLength: 280, type: "string" }),
    environment: Runtime.lexString({
      enum: ["sandbox", "production"],
      type: "string",
    }).pipe(Schema.decodeTo(Schema.Literals(["sandbox", "production"]))),
    messageId: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    title: Runtime.lexString({ maxLength: 128, type: "string" }),
    token: Runtime.lexString({ maxLength: 512, minLength: 2, type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type NoticeValue = typeof Notice.Type;

export const Params = Schema.StructWithRest(
  Schema.Struct({
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
  Schema.Struct({ notice: Schema.optionalKey(Notice) }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({ recipientDid: Schema.String }),
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
] as const;

export type KnownError = (typeof KnownErrors)[number];

export const isKnownError = (value: string): value is KnownError =>
  KnownErrors.some((name) => name === value);

export const Method = {
  defaults: {},
  error: ErrorBody,
  input: Input,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.device.pendingPush",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.device.pendingPush",
} as const;
