import { Effect, Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const CriticalCount = Schema.StructWithRest(
  Schema.Struct({
    count: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    day: Runtime.lexString({ type: "string" }),
    senderDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type CriticalCountValue = typeof CriticalCount.Type;

export const Via = Schema.StructWithRest(
  Schema.Struct({
    desk: Runtime.lexString({ maxLength: 256, minLength: 1, type: "string" }),
    deskDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    run: Defs.PassRun,
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type ViaValue = typeof Via.Type;

export const Entry = Schema.StructWithRest(
  Schema.Struct({
    body: Schema.optionalKey(
      Runtime.lexString({
        description:
          "UTF-8 body of a signed plaintext message, verified at admission. Absent for encrypted messages.",
        type: "string",
      })
    ),
    ciphertextSize: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    messageId: Runtime.lexString({ format: "tid", type: "string" }).pipe(
      Schema.brand("Lexicon:tid")
    ),
    recipientDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    recipientSeq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    resolvedFrom: Schema.optionalKey(
      Runtime.lexString({
        description:
          "The name the sender addressed, when it resolved to this recipient through a role or a successor.",
        maxLength: 128,
        type: "string",
      })
    ),
    senderDid: Runtime.lexString({ format: "did", type: "string" }).pipe(
      Schema.brand("Lexicon:did")
    ),
    seq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
    state: Runtime.lexString({
      knownValues: [
        "accepted",
        "queued",
        "delivered",
        "acked",
        "expired",
        "failed",
      ],
      type: "string",
    }),
    time: Runtime.lexString({ format: "datetime", type: "string" }).pipe(
      Schema.brand("Lexicon:datetime")
    ),
    via: Schema.optionalKey(Via),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type EntryValue = typeof Entry.Type;

export const Params = Schema.StructWithRest(
  Schema.Struct({
    cursor: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    limit: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(100)
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
    criticalCounts: Schema.optionalKey(
      Schema.Array(CriticalCount).check(
        Schema.isMinLength(0),
        Schema.isMaxLength(100)
      )
    ),
    cursor: Runtime.lexString({ type: "string" }),
    events: Schema.Array(Entry).check(
      Schema.isMinLength(0),
      Schema.isMaxLength(100)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type OutputValue = typeof Output.Type;

export const ParamsFromQuery = Schema.StructWithRest(
  Schema.Struct({
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.FiniteFromString),
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
  "AuthRequired",
  "Forbidden",
  "InvalidCursor",
  "MailboxUnavailable",
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
  nsid: "sh.mschf.ratking.mailbox.listTraffic",
  output: Output,
  outputEncoding: "application/json",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.listTraffic",
} as const;
