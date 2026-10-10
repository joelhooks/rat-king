import { Effect, Option, Schema } from "effect";

import { AgentName } from "./name.ts";

export const Kind = Schema.Literals(["message", "ask", "reply", "data"]);

export type KindValue = typeof Kind.Type;

export const Payload = Schema.Struct({
  body: Schema.String,
  from: AgentName,
  kind: Schema.optionalKey(Kind),
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  replyTo: Schema.optionalKey(Schema.String),
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
  readonly cc: boolean;
}

export const replyHint = (tool: string, inbound: Inbound) =>
  [
    `To reply: ${tool}({ action: "reply", replyTo: "${inbound.id}", message: "..." })`,
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
    "",
    inbound.body,
    "",
    replyHint(tool, inbound),
  ].join("\n");
};
