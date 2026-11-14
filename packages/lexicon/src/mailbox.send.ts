import { Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Runtime from "./runtime.ts";

export const Params = Schema.Undefined;

export type ParamsValue = typeof Params.Type;

export const Input = Schema.StructWithRest(
  Schema.Struct({
    critical: Schema.optionalKey(Schema.Boolean),
    envelope: Defs.EncryptedEnvelope,
    generation: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      )
    ),
    leaseId: Schema.optionalKey(
      Runtime.lexString({ format: "tid", type: "string" }).pipe(
        Schema.brand("Lexicon:tid")
      )
    ),
    resolvedFrom: Schema.optionalKey(
      Runtime.lexString({
        description:
          "The name the sender addressed, from identity.resolveRecipient. The mailbox resolves it again at accept time and refuses RoleUnresolved unless it still resolves to the envelope's recipient. Recorded on the receipt and traffic entry.",
        maxLength: 128,
        type: "string",
      })
    ),
    wakeReason: Schema.optionalKey(
      Runtime.lexString({
        enum: ["to", "ask", "reply", "cc", "quiet", "data"],
        type: "string",
      }).pipe(
        Schema.decodeTo(
          Schema.Literals(["to", "ask", "reply", "cc", "quiet", "data"])
        )
      )
    ),
    woke: Schema.optionalKey(Schema.Boolean),
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
  "LeaseMismatch",
  "Retired",
  "RoleUnresolved",
  "InvalidRequest",
  "AuthRequired",
  "Forbidden",
  "Conflict",
  "UnsupportedEnvelope",
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
  nsid: "sh.mschf.ratking.mailbox.send",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.send",
} as const;
