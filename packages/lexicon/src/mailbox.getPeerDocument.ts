import { Effect, Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Params = Schema.StructWithRest(
  Schema.Struct({
    did: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ParamsValue = typeof Params.Type;

export const Input = Schema.Undefined;

export type InputValue = typeof Input.Type;

export const Output = Schema.StructWithRest(
  Schema.Struct({ document: Defs.DidDocument }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({ did: Schema.String }),
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
  "DocumentNotFound",
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
  nsid: "sh.mschf.ratking.mailbox.getPeerDocument",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.getPeerDocument",
} as const;
