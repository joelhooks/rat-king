import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Retirement = Schema.StructWithRest(
  Schema.Struct({
    by: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    did: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
    retiredAt: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    successor: Schema.optionalKey(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ),
    updatedAt: Schema.optionalKey(
      Runtime.lexString({
        description:
          "When identity.setSuccessor last re-pointed the retirement.",
        format: "datetime",
        type: "string",
      }).pipe(Schema.brand("Lexicon:datetime"))
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type RetirementValue = typeof Retirement.Type;

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Schema.StructWithRest(
  Schema.Struct({
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
    successor: Schema.optionalKey(
      Runtime.lexString({ maxLength: 128, type: "string" })
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type InputValue = typeof Input.Type;

export const Output = Retirement;

export type OutputValue = typeof Output.Type;

export const ErrorBody = Runtime.XrpcErrorBody;

export type ErrorBodyValue = typeof ErrorBody.Type;

export const KnownErrors = [
  "InvalidRequest",
  "InvalidName",
  "AuthRequired",
  "Forbidden",
  "NameReserved",
  "NameNotFound",
  "LeaseLive",
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
  nsid: "sh.mschf.ratking.identity.retireName",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.identity.retireName",
} as const;
