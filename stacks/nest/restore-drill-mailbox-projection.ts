import { Schema } from "effect";

import {
  MailboxCounts,
  ProofAssertionFailure,
} from "./restore-drill-proof-assertion.ts";

const Count = MailboxCounts.fields.messages;

export const MailboxKeyProof = Schema.Struct({
  admissionEvents: Count,
  duplicateAdmissionEvents: Count,
  eventKeys: Count,
  eventKeysWithoutState: Schema.Literal(0),
  mailboxIndex: Count,
  stateKeys: Count,
  stateKeysWithoutEvent: Schema.Literal(0),
});

export const MessageKey = Schema.Struct({
  messageId: Schema.NonEmptyString,
  recipientDid: Schema.NonEmptyString,
  senderDid: Schema.NonEmptyString,
});

export const AdmissionKey = Schema.Struct({
  message: Schema.Struct({
    messageId: Schema.NonEmptyString,
    senderDid: Schema.NonEmptyString,
  }),
  recipientDid: Schema.NonEmptyString,
});

export const messageKeyIdentity = (key: typeof MessageKey.Type): string =>
  JSON.stringify([key.recipientDid, key.senderDid, key.messageId]);

export const admissionKeyIdentity = (
  receipt: typeof AdmissionKey.Type
): string =>
  messageKeyIdentity({
    messageId: receipt.message.messageId,
    recipientDid: receipt.recipientDid,
    senderDid: receipt.message.senderDid,
  });

export const requireMailboxKeys = (
  stored: readonly (typeof MessageKey.Type)[],
  events: ReadonlySet<string>,
  mailboxIndex: number
): Omit<
  typeof MailboxKeyProof.Type,
  "admissionEvents" | "duplicateAdmissionEvents" | "mailboxIndex"
> => {
  const state = new Set(stored.map(messageKeyIdentity));

  const eventKeysWithoutState = [...events].filter(
    (key) => !state.has(key)
  ).length;

  const stateKeysWithoutEvent = [...state].filter(
    (key) => !events.has(key)
  ).length;

  if (eventKeysWithoutState !== 0) {
    throw new ProofAssertionFailure({
      actual: eventKeysWithoutState,
      assertionCode: "EVENT_KEYS_WITHOUT_STATE",
      expected: 0,
      mailboxIndex,
    });
  }

  if (stateKeysWithoutEvent !== 0) {
    throw new ProofAssertionFailure({
      actual: stateKeysWithoutEvent,
      assertionCode: "STATE_KEYS_WITHOUT_EVENT",
      expected: 0,
      mailboxIndex,
    });
  }

  return {
    eventKeys: events.size,
    eventKeysWithoutState,
    stateKeys: state.size,
    stateKeysWithoutEvent,
  };
};
