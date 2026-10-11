import { Effect, Option, Schema } from "effect";

import { AgentName } from "./name.ts";

export const LexiconRecord = Schema.StructWithRest(
  Schema.Struct({ $type: Schema.String }),
  [Schema.Record(Schema.String, Schema.Json)]
);

export type LexiconRecordValue = typeof LexiconRecord.Type;

export const RecordJson = Schema.fromJsonString(LexiconRecord);

export const decodeRecord = (body: string) =>
  Schema.decodeEffect(RecordJson)(body).pipe(Effect.option);

export interface InboundRecord {
  readonly id: string;
  readonly did: string;
  readonly from: string;
  readonly verified: boolean;
  readonly record: LexiconRecordValue;
  readonly replyTo: Option.Option<string>;
}

export const SUMMARY_MAX = 280;

export const Kind = Schema.Literals(["message", "ask", "reply", "data"]);

export type KindValue = typeof Kind.Type;

export const Payload = Schema.Struct({
  body: Schema.String,
  cc: Schema.optionalKey(Schema.Array(AgentName)),
  from: AgentName,
  kind: Schema.optionalKey(Kind),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  replyTo: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(SUMMARY_MAX))
  ),
  thread: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(AgentName),
});

export type PayloadValue = typeof Payload.Type;

export const PayloadJson = Schema.fromJsonString(Payload);

export const encodePayload = Effect.fn("RatKing.encodePayload")(
  function* encodePayload(payload: PayloadValue) {
    return yield* Schema.encodeEffect(PayloadJson)(payload);
  }
);

export const decodePayload = (body: string) =>
  Schema.decodeEffect(PayloadJson)(body).pipe(Effect.option);

export interface Inbound {
  readonly id: string;
  readonly did: string;
  readonly from: string;
  readonly label: Option.Option<string>;
  readonly verified: boolean;
  readonly body: string;
  readonly kind: KindValue;
  readonly replyTo: Option.Option<string>;
  readonly summary: Option.Option<string>;
  readonly cc: boolean;
  readonly ccNames?: readonly string[];
  readonly to?: string;
  readonly thread?: string;
}

export const replyHint = (tool: string, inbound: Inbound) =>
  [
    `To reply: ${tool}({ action: "reply", replyTo: "${inbound.id}", summary: "...", message: "..." })`,
    ...(inbound.kind === "ask"
      ? ["The sender is waiting for this reply."]
      : []),
  ].join("\n");

export const renderInbound = (tool: string, inbound: Inbound) => {
  const name = inbound.verified
    ? inbound.from
    : `${inbound.from} (unverified name; sender ${inbound.did})`;

  const sender = Option.match(inbound.label, {
    onNone: () => name,
    onSome: (label) => `${label} (${name})`,
  });

  const label = inbound.cc ? "Rat King CC" : "Rat King message";

  const thread = Option.match(inbound.replyTo, {
    onNone: () => "",
    onSome: (id) => ` · in reply to ${id}`,
  });

  return [
    `**${label} from ${sender}** · id ${inbound.id}${thread}`,
    ...((inbound.ccNames?.length ?? 0) > 0
      ? [`cc: ${(inbound.ccNames ?? []).join(", ")}`]
      : []),
    "",
    ...Option.match(inbound.summary, {
      onNone: () => [],
      onSome: (summary) => [`Summary: ${summary}`, ""],
    }),
    inbound.body,
    "",
    replyHint(tool, inbound),
  ].join("\n");
};
