import { Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Runtime from "./runtime.ts";

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Schema.StructWithRest(
  Schema.Struct({
    generation: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    leaseId: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    message: Defs.MessageRef,
    recipientDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({ receipt: Defs.Receipt }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ErrorBody = Runtime.XrpcErrorBody;

export type ErrorBodyValue = typeof ErrorBody.Type;

export const KnownErrors = [
  "InvalidRequest",
  "AuthRequired",
  "Forbidden",
  "MessageNotFound",
  "LeaseMismatch",
  "InvalidTransition",
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
  nsid: "sh.mschf.ratking.mailbox.ack",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.ack",
} as const;
