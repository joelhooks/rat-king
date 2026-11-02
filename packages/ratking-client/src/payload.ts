import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Option, Schema } from "effect";

import { PayloadJson } from "../../mailbox-client/src/payload.ts";
import type {
  KindValue,
  ReplyRefValue,
} from "../../mailbox-client/src/payload.ts";
import { renderRecordBody } from "./agentgraph.ts";
import { formatReason } from "./attend.ts";
import type { Levers } from "./attend.ts";
import { deliveryReason, quietCopy } from "./delivery.ts";
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
  readonly encrypted?: boolean;
  readonly levers?: unknown;
  readonly id: string;
  readonly did: string;
  readonly from: string;
  readonly verified: boolean;
  readonly record: LexiconRecordValue;
  readonly replyTo: Option.Option<string>;
}

export {
  encodePayload,
  wakeIntent,
  Kind,
  Payload,
  PayloadJson,
  SUMMARY_HARD_MAX,
  SUMMARY_MAX,
  SUMMARY_WIRE_MAX,
} from "../../mailbox-client/src/payload.ts";

export type {
  KindValue,
  PayloadValue,
} from "../../mailbox-client/src/payload.ts";

export const replyRef = (parent: string, root = parent): ReplyRefValue => ({
  parent,
  root,
});

export const inboundReply = (
  inbound: Pick<Inbound, "reply" | "replyTo">
): Option.Option<ReplyRefValue> =>
  Option.orElse(Option.fromNullishOr(inbound.reply), () =>
    Option.map((parent: string) => replyRef(parent))(inbound.replyTo)
  );

export const decodePayload = (body: string) =>
  Schema.decodeEffect(PayloadJson)(body).pipe(Effect.option);

export const RelaySource = Schema.Struct({
  did: Schema.String,
  encrypted: Schema.Boolean,
  name: AgentName,
});

export const PassSource = Schema.Struct({
  desk: Schema.String,
  deskDid: Schema.String,
  run: Defs.PassRun,
});

export const passMarker = (via: typeof PassSource.Type): string => {
  const [label, id = ""] = via.run.split(":");

  return `↳ via headless Pi ${label} (${id.slice(0, 8)})`;
};

export interface Inbound {
  readonly threadRouter?: typeof RelaySource.Type;
  readonly routedCopy?: boolean;
  readonly routedWake?: boolean;
  readonly via?: typeof PassSource.Type;
  readonly delegatedFor?: string;
  readonly delegatedTo?: string;
  readonly originalId?: string;
  readonly levers?: Levers;
  readonly sender?: string;
  readonly askSummary?: string;
  readonly noReply?: boolean;
  readonly relay?: typeof RelaySource.Type;
  readonly sentBy?: string;
  readonly id: string;
  readonly did: string;
  readonly from: string;
  readonly label: Option.Option<string>;
  readonly verified: boolean;
  readonly body: string;
  readonly kind: KindValue;
  readonly quiet?: boolean;
  readonly reply?: ReplyRefValue;
  readonly replyTo: Option.Option<string>;
  readonly summary: Option.Option<string>;
  readonly cc: boolean;
  readonly ccNames?: readonly string[];
  readonly copy?: boolean;
  readonly digestMinutes?: number;
  readonly to?: string;
  readonly thread?: string;
}

export const replyHint = (tool: string, inbound: Inbound) =>
  [
    `To reply${inbound.relay === undefined ? "" : ` to ${inbound.from}`}: ${tool}({ action: "reply", replyTo: "${inbound.id}", ${inbound.relay === undefined ? "" : "replyAll: false, "}summary: "...", message: "..." })`,
    ...(inbound.relay === undefined
      ? []
      : [
          `To confirm handled without replying: ${tool}({ action: "handled", replyTo: "${inbound.id}" })`,
        ]),
    ...(inbound.kind === "ask"
      ? ["The sender is waiting for this reply."]
      : []),
  ].join("\n");

const renderSent = (inbound: Inbound, by: string) =>
  [
    `**🐀 sent by ${by}** · to ${inbound.to ?? "unknown"} · id ${inbound.id}${Option.match(
      inbound.replyTo,
      { onNone: () => "", onSome: (id) => ` · in reply to ${id}` }
    )}`,
    ...((inbound.ccNames?.length ?? 0) > 0
      ? [`cc: ${(inbound.ccNames ?? []).join(", ")}`]
      : []),
    "",
    ...Option.match(inbound.summary, {
      onNone: () => [],
      onSome: (summary) => [`Summary: ${summary}`, ""],
    }),
    inbound.kind === "data" ? renderRecordBody(inbound.body) : inbound.body,
    "",
    `Context only: ${by} already sent this. Do not reply to it.`,
  ].join("\n");

export const COPY_BODY_MAX = 500;

export const COPY_NOTE =
  "You are cc'd, so this did not wake you. No action is expected unless it names you; the sender uses to: for whoever must act.";

const copyBody = (inbound: Inbound) => {
  if (Option.isSome(inbound.summary)) {
    return "(Full text kept in the session view.)";
  }

  return inbound.body.length > COPY_BODY_MAX
    ? `${inbound.body.slice(0, COPY_BODY_MAX)}… (clipped; full text kept in the session view)`
    : inbound.body;
};

export const renderInbound = (tool: string, inbound: Inbound) => {
  if (inbound.noReply === true) {
    return inbound.body;
  }

  if (inbound.sentBy !== undefined) {
    return renderSent(inbound, inbound.sentBy);
  }

  const name = inbound.verified
    ? inbound.from
    : `${inbound.from} (unverified name; sender ${inbound.did})`;

  const sender = Option.match(inbound.label, {
    onNone: () => name,
    onSome: (label) => `${label} (${name})`,
  });

  const label = inbound.cc ? "🐀 cc" : "🐀";
  const heading = inbound.kind === "reply" ? "🐀 reply" : label;

  const thread = Option.match(inbound.replyTo, {
    onNone: () => "",
    onSome: (id) => ` · in reply to ${id}`,
  });

  return [
    `**${heading} from ${sender}** · id ${inbound.id}${thread}${inbound.relay === undefined ? "" : ` · via ${inbound.relay.name}`} · ${formatReason(deliveryReason(inbound))}`,
    ...(inbound.via === undefined ? [] : [passMarker(inbound.via)]),
    ...(inbound.delegatedFor === undefined
      ? []
      : [`for ${inbound.delegatedFor}`]),
    ...(inbound.askSummary === undefined
      ? []
      : [
          `This is the answer to your ask ${Option.getOrElse(inbound.replyTo, () => "")}. Original summary: ${JSON.stringify(inbound.askSummary)}`,
        ]),
    ...((inbound.ccNames?.length ?? 0) > 0
      ? [`cc: ${(inbound.ccNames ?? []).join(", ")}`]
      : []),
    "",
    ...Option.match(inbound.summary, {
      onNone: () => [],
      onSome: (summary) => [`Summary: ${summary}`, ""],
    }),
    ...(quietCopy(inbound)
      ? [copyBody(inbound), "", COPY_NOTE]
      : [
          inbound.kind === "data"
            ? renderRecordBody(inbound.body)
            : inbound.body,
        ]),
    "",
    replyHint(tool, inbound),
  ].join("\n");
};
