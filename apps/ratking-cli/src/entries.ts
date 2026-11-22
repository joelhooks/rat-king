import type { Inbound, InboundRecord } from "@rat-king/ratking-client/payload";
import type { ReceivedMail } from "@rat-king/ratking-client/received-mail";
import { Option } from "effect";

import { isRecord } from "./render.ts";

export const threadOf = (received: Inbound | InboundRecord) =>
  isRecord(received)
    ? received.id
    : (received.reply?.root ?? received.thread ?? received.id);

export const entryDocument = (
  entry: ReceivedMail & { readonly state: string }
) => {
  const { received } = entry;

  if (isRecord(received)) {
    return {
      ...received,
      encrypted: entry.encrypted,
      from: received.from,
      id: received.id,
      kind: "record",
      record: received.record,
      redelivered: entry.redelivered,
      replyTo: Option.getOrNull(received.replyTo),
      seq: entry.seq,
      state: entry.state,
      verified: received.verified,
    };
  }

  return {
    ...received,
    carbonCopy: received.cc,
    cc: received.ccNames ?? [],
    encrypted: entry.encrypted,
    from: received.from,
    id: received.id,
    kind: received.kind,
    label: Option.getOrNull(received.label),
    redelivered: entry.redelivered,
    replyTo: Option.getOrNull(received.replyTo),
    seq: entry.seq,
    state: entry.state,
    summary: Option.getOrNull(received.summary),
    thread: received.thread ?? threadOf(received),
    to: received.to ?? null,
    verified: received.verified,
  };
};
