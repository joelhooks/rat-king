import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Result = Schema.StructWithRest(
  Schema.Struct({
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
    outcome: Runtime.lexString({
      enum: ["recorded", "already", "unknown"],
      type: "string",
    }).pipe(
      Schema.decodeTo(Schema.Literals(["recorded", "already", "unknown"]))
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ResultValue = typeof Result.Type;

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Schema.StructWithRest(
  Schema.Struct({
    names: Schema.Array(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({
    results: Schema.Array(Result).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(100)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

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
  inputEncoding: "application/json",
  method: "POST",
  nsid: "sh.mschf.ratking.identity.recordRetired",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.identity.recordRetired",
} as const;
