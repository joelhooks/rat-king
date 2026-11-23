import type { Message } from "./view.ts";

const mentions = /^(?:@[\w/-]+[:,]?\s+)+/u;

const kindPrefix =
  /^(?<kind>action|blocked|done|fyi|progress|question)\s+[\w/-]+\s*·\s*/iu;

const packetPrefix = /^Packet [a-f\d]+ from [\w/-]+:\s*/iu;

const speakerPrefix = /^\p{Lu}[\p{L}\p{M}'’-]*:\s+/u;

const sessionId =
  /\b(?:[\w/-]+-)?\d{8}T\d{6}-[a-f\d]{7,}\b|\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/giu;

const hex = /(?<![\p{L}\p{N}_])(?=[a-f]*\d)[a-f\d]{7,}(?![\p{L}\p{N}_])/giu;

const signature = /(?:^|\s)(?:SR\s+)?🐀$/u;

const sentenceEnd = /[.!?]+(?=\s+\S)/u;

const maxTitle = 90;

const heading = (message: Extract<Message, { mode: "signed" }>) =>
  (
    message.payload?.summary ??
    (message.payload?.body ?? message.body).split(/\r?\n/u, 1)[0] ??
    ""
  ).trim();

export const displayKind = (message: Message) => {
  if (message.mode === "sealed") {
    return null;
  }

  const kind = message.payload?.kind;

  if (kind !== undefined && kind !== "message") {
    return kind;
  }

  return (
    kindPrefix
      .exec(heading(message).replace(mentions, ""))
      ?.groups?.kind?.toLowerCase() ?? null
  );
};

const shorten = (text: string) => {
  const sentence = sentenceEnd.exec(text);

  if (sentence !== null && sentence.index + sentence[0].length <= maxTitle) {
    return `${text.slice(0, sentence.index)}…`;
  }

  if (text.length <= maxTitle) {
    return text;
  }

  const within = text.slice(0, maxTitle);
  const boundary = text[maxTitle] === " " ? maxTitle : within.lastIndexOf(" ");

  return `${within.slice(0, boundary > 0 ? boundary : maxTitle).trimEnd()}…`;
};

const shortDid = (did: string) =>
  /^did:web:(?<label>[^.:%]+)/u.exec(did)?.groups?.label ?? did;

export const sealedSender = (message: Extract<Message, { mode: "sealed" }>) =>
  message.senderName ?? shortDid(message.sender);

export const displayTitle = (message: Message) => {
  if (message.mode === "sealed") {
    const recipients = [...message.recipients].map(shortDid).join(", ");

    return `Sealed · ${sealedSender(message)} → ${recipients}`;
  }

  const original = heading(message);
  let text = original;

  while (true) {
    const stripped = text
      .replace(mentions, "")
      .replace(kindPrefix, "")
      .replace(packetPrefix, "")
      .replace(speakerPrefix, "");

    if (stripped === text) {
      break;
    }

    text = stripped;
  }

  text = text
    .replace(sessionId, " ")
    .replace(hex, " ")
    .replace(signature, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

  if ((text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 3) {
    return shorten(text);
  }

  return original === "" ? "Signed message" : original;
};
