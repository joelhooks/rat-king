import { Schema } from "effect";

import * as Runtime from "./runtime.ts";

export const Role = Schema.StructWithRest(
  Schema.Struct({
    name: Runtime.lexString({ maxLength: 128, type: "string" }),
    role: Runtime.lexString({
      description: "One-line description of the role.",
      maxLength: 120,
      minLength: 1,
      type: "string",
    }),
    target: Runtime.lexString({ maxLength: 128, type: "string" }),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type RoleValue = typeof Role.Type;

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Role;

export type InputValue = typeof Input.Type;

export const Output = Role;

export type OutputValue = typeof Output.Type;

export const ErrorBody = Runtime.XrpcErrorBody;

export type ErrorBodyValue = typeof ErrorBody.Type;

export const KnownErrors = [
  "InvalidRequest",
  "InvalidName",
  "AuthRequired",
  "Forbidden",
  "NameCollision",
  "UnknownName",
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
  nsid: "sh.mschf.ratking.identity.setRole",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.identity.setRole",
} as const;
