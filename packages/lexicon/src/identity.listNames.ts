import { Effect, Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Parent = Schema.StructWithRest(
  Schema.Struct({
    name: Runtime.lexString({ maxLength: 128, type: "string" }).check(
      Schema.isPattern(
        /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u
      )
    ),
    session: Runtime.lexString({ minLength: 1, type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ParentValue = typeof Parent.Type;

export const Entry = Schema.StructWithRest(
  Schema.Struct({
    did: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    document: Defs.DidDocument,
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
    parent: Schema.optionalKey(Parent),
    roleTarget: Schema.optionalKey(Schema.Boolean),
    status: Schema.optionalKey(
      Runtime.lexString({
        enum: ["live", "idle", "retired"],
        type: "string",
      }).pipe(Schema.decodeTo(Schema.Literals(["live", "idle", "retired"])))
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type EntryValue = typeof Entry.Type;

export const Params = Schema.StructWithRest(
  Schema.Struct({
    all: Schema.optionalKey(Schema.Boolean),
    cursor: Schema.optionalKey(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(100)
      )
    ),
    match: Schema.optionalKey(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ),
    status: Schema.optionalKey(
      Runtime.lexString({ maxLength: 32, type: "string" }).check(
        Schema.isPattern(/^(?:live|idle|retired)(?:,(?:live|idle|retired))*$/u)
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ParamsValue = typeof Params.Type;

export const Input = Schema.Undefined;

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({
    cursor: Schema.optionalKey(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ),
    names: Schema.Array(Entry).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(100)
    ),
    scanned: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({
    all: Schema.optionalKey(Query.BooleanFromQuery),
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.FiniteFromString),
    match: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
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
  "MailboxUnavailable",
] as const;

export type KnownError = (typeof KnownErrors)[number];

export const isKnownError = (value: string): value is KnownError =>
  KnownErrors.some((name) => name === value);

export const Method = {
  defaults: { limit: 100 },
  error: ErrorBody,
  input: Input,
  inputEncoding: "",
  method: "GET",
  nsid: "sh.mschf.ratking.identity.listNames",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.identity.listNames",
} as const;
