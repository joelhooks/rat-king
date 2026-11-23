import type { EntryValue } from "@rat-king/lexicon/mailbox.listTraffic";
import { PayloadJson } from "@rat-king/mailbox-client/payload";
import type { PayloadValue } from "@rat-king/mailbox-client/payload";
import { Option, Schema } from "effect";

const decodePayload = Schema.decodeOption(PayloadJson);

interface MessageBase {
  readonly key: number;
  readonly id: string;
  readonly sender: string;
  readonly time: string;
  readonly recipients: ReadonlySet<string>;
  readonly addressed: ReadonlySet<string>;
}

export type Message = MessageBase &
  (
    | { readonly mode: "sealed"; readonly size: number }
    | {
        readonly mode: "signed";
        readonly body: string;
        readonly payload: PayloadValue | undefined;
      }
  );

interface Thread {
  readonly key: number;
  readonly messages: readonly Message[];
  readonly asks: readonly {
    readonly message: Message;
    readonly answered: boolean;
  }[];
}

export interface Project {
  readonly name: string;
  readonly threads: readonly Thread[];
}

const sameDelivery = (e: EntryValue) =>
  JSON.stringify([e.senderDid, e.messageId]);

const messages = (events: readonly EntryValue[]) => {
  const byId = new Map<string, Message>();

  for (const event of events) {
    const key = sameDelivery(event);
    const prior = byId.get(key);
    const recipients = new Set(prior?.recipients).add(event.recipientDid);
    const addressed = new Set(prior?.addressed);

    if (event.resolvedFrom !== undefined) {
      addressed.add(event.resolvedFrom);
    }

    if (prior !== undefined) {
      byId.set(key, { ...prior, addressed, recipients });
      continue;
    }

    const base = {
      addressed,
      id: event.messageId,
      key: event.seq,
      recipients,
      sender: event.senderDid,
      time: event.time,
    };

    byId.set(
      key,
      event.body === undefined
        ? { ...base, mode: "sealed", size: event.ciphertextSize }
        : {
            ...base,
            body: event.body,
            mode: "signed",
            payload: Option.getOrUndefined(decodePayload(event.body)),
          }
    );
  }

  return [...byId.values()];
};

export const payloadOf = (message: Message) =>
  message.mode === "signed" ? message.payload : undefined;

export const parentOf = (message: Message) => {
  const payload = payloadOf(message);

  return payload?.reply?.parent ?? payload?.replyTo;
};

const projectsOf = (message: Message) => {
  const payload = payloadOf(message);

  const names = [
    payload?.from,
    payload?.to,
    ...(payload?.cc ?? []),
    ...message.addressed,
  ];

  return names.flatMap((name) => {
    const split = name?.indexOf("/") ?? -1;

    return split > 0 && name !== undefined ? [name.slice(0, split)] : [];
  });
};

const threadId = (message: Message, seen: ReadonlyMap<string, string>) => {
  const payload = payloadOf(message);
  const parent = parentOf(message);

  return (
    payload?.reply?.root ??
    payload?.thread ??
    (parent === undefined ? message.id : (seen.get(parent) ?? parent))
  );
};

export const projectTraffic = (
  events: readonly EntryValue[]
): readonly Project[] => {
  const groups = new Map<string, Message[]>();
  const seen = new Map<string, string>();

  for (const message of messages(events)) {
    const signedRoot = threadId(message, seen);

    const root =
      message.mode === "sealed"
        ? JSON.stringify(["sealed", message.sender, message.id])
        : JSON.stringify(["signed", signedRoot]);

    const thread = groups.get(root) ?? [];
    thread.push(message);
    groups.set(root, thread);

    if (message.mode === "signed") {
      seen.set(message.id, signedRoot);
    }
  }

  const projects = new Map<string, Thread[]>();

  for (const thread of groups.values()) {
    const [first] = thread;

    if (first === undefined) {
      continue;
    }

    const names = new Set(thread.flatMap(projectsOf));

    if (names.size === 0) {
      names.add("Unassigned");
    }

    const asks = thread
      .filter((message) => payloadOf(message)?.kind === "ask")
      .map((message) => ({
        answered: thread.some(
          (reply) =>
            payloadOf(reply)?.kind === "reply" &&
            parentOf(reply) === message.id &&
            message.recipients.has(reply.sender) &&
            reply.recipients.has(message.sender)
        ),
        message,
      }));

    for (const name of names) {
      const threads = projects.get(name) ?? [];
      threads.push({ asks, key: first.key, messages: thread });
      projects.set(name, threads);
    }
  }

  return [...projects]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, threads]) => ({
      name,
      threads: threads.toReversed(),
    }));
};
