import type { Inbound, InboundRecord } from "@rat-king/ratking-client/payload";
import type { Delivered, LeaseHolder } from "@rat-king/ratking-client/ratking";
import type { ReceivedMail } from "@rat-king/ratking-client/received-mail";
import type { Received } from "@rat-king/ratking-client/threads";
import { Option } from "effect";

export const short = (id: string) => id.slice(0, 8);

export const oneLine = (text: string, max = 80) =>
  text.replaceAll(/\s+/gu, " ").trim().slice(0, max);

export const recipientsOf = (delivered: Delivered) =>
  delivered.recipients ?? [{ level: "wake" as const, name: delivered.to }];

export const sentLine = (verb: string, delivered: Delivered) => {
  const [first, ...rest] = recipientsOf(delivered);
  const names = first === undefined ? delivered.to : first.name;

  return [
    `🐀 ${verb} ${names}`,
    ...(rest.length === 0
      ? []
      : [`cc ${rest.map((recipient) => recipient.name).join(", ")}`]),
    short(delivered.id),
    `seq ${delivered.seq}`,
  ].join(" · ");
};

export const isRecord = <Entry extends Inbound | InboundRecord>(
  received: Entry
): received is Extract<Entry, InboundRecord> => "record" in received;

export const partyOf = (received: Inbound | InboundRecord) =>
  isRecord(received)
    ? received.from
    : Option.getOrElse(received.label, () => received.from);

const verbOf = (received: Inbound | InboundRecord) => {
  if (isRecord(received)) {
    return "record from";
  }

  if (received.kind === "ask") {
    return "ask from";
  }

  if (received.kind === "reply") {
    return "reply from";
  }

  return received.cc ? "cc from" : "from";
};

const factsOf = (entry: ReceivedMail) => {
  const { received } = entry;

  return [
    short(received.id),
    ...(isRecord(received)
      ? [`${JSON.stringify(received.record).length} bytes`]
      : [
          oneLine(
            Option.getOrElse(received.summary, () => received.body),
            72
          ),
        ]),
    ...(received.verified ? [] : ["unverified"]),
    ...(entry.encrypted === false ? ["plaintext"] : []),
    ...(entry.redelivered === true ? ["redelivered"] : []),
  ];
};

export const inboxLine = (entry: ReceivedMail) =>
  `🐀 ${verbOf(entry.received)} ${partyOf(entry.received)} · ${factsOf(entry).join(" · ")}`;

export const readLines = (entry: ReceivedMail) => {
  const { received } = entry;

  return [
    inboxLine(entry),
    ...(isRecord(received)
      ? ["", JSON.stringify(received.record, null, 2)]
      : [
          ...Option.match(received.summary, {
            onNone: () => [],
            onSome: (summary) => ["", `Summary: ${summary}`],
          }),
          "",
          received.body,
        ]),
  ];
};

export const holderLine = (holder: Option.Option<LeaseHolder>) =>
  Option.match(holder, {
    onNone: () => "lease free",
    onSome: (value) =>
      value.live
        ? `lease held by ${value.session} (${value.harness}) until ${value.expiresAt}`
        : `lease expired ${value.expiresAt}, last held by ${value.session}`,
  });

export const pendingLines = (asks: readonly Received[]) =>
  asks.length === 0
    ? ["🐀 pending · none"]
    : asks.map((ask) =>
        ask.outbound === undefined
          ? `🐀 ask from ${ask.from} · ${short(ask.id)} · ${oneLine(ask.preview)}`
          : `🐀 asked ${ask.outbound.to} · ${short(ask.id)} · ${oneLine(ask.outbound.summary)}`
      );
