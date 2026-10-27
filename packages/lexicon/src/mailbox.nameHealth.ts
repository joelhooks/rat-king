import { Effect, Schema } from "effect";

import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Lease = Schema.StructWithRest(
  Schema.Struct({
    expiresAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    generation: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    holder: Runtime.lexString({ type: "string" }),
    pane: Schema.optionalKey(Runtime.lexString({ type: "string" })),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type LeaseValue = typeof Lease.Type;

export const Wake = Schema.StructWithRest(
  Schema.Struct({
    id: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    recordedAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    sender: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    woke: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type WakeValue = typeof Wake.Type;

export const Params = Schema.StructWithRest(
  Schema.Struct({
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
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
    complete: Schema.Boolean,
    lastAck: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
    lease: Schema.optionalKey(Lease),
    oldestWake: Schema.optionalKey(Wake),
    quietUnacked: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({ name: Schema.String, recipientDid: Schema.String }),
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
  nsid: "sh.mschf.ratking.mailbox.nameHealth",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.nameHealth",
} as const;
