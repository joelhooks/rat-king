import { Effect, Schema } from "effect";

import * as Query from "./query.ts";
import * as Runtime from "./runtime.ts";

export const Auth = Schema.StructWithRest(
  Schema.Struct({ token: Runtime.lexString({ type: "string" }) }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type AuthValue = typeof Auth.Type;

export const Params = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Runtime.Data),
]);

export type ParamsValue = typeof Params.Type;

export const Message = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      $type: Schema.Literal("sh.mschf.ratking.mailbox.subscribeTraffic#notice"),
      seq: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
      ),
    }),
    [Schema.Record(Schema.String, Runtime.Data)]
  ),
  Runtime.TaggedMap.check(
    Schema.makeFilter(
      (value) =>
        !["sh.mschf.ratking.mailbox.subscribeTraffic#notice"].includes(
          value.$type
        ),
      { expected: "unknown union tag only" }
    )
  ),
]);

export type MessageValue = typeof Message.Type;

export const ParamsFromQuery = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Runtime.Data),
]).pipe(Schema.decodeTo(Params));

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

export const KnownErrors = [
  "AuthRequired",
  "Forbidden",
  "MailboxUnavailable",
] as const;

export type KnownError = (typeof KnownErrors)[number];

export const isKnownError = (value: string): value is KnownError =>
  KnownErrors.some((name) => name === value);

export const Method = {
  nsid: "sh.mschf.ratking.mailbox.subscribeTraffic",
  params: Params,
  path: "/xrpc/sh.mschf.ratking.mailbox.subscribeTraffic",
} as const;

export const Notice = Schema.StructWithRest(
  Schema.Struct({
    seq: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(9_007_199_254_740_991)
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type NoticeValue = typeof Notice.Type;
