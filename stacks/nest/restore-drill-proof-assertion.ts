import { Effect, Schema } from "effect";

export const AssertionCode = Schema.Literals([
  "NAMESPACE_NOT_PRIVATE",
  "MISSING_BINDING",
  "EXPECTED_KEYPAIR",
  "NAME_CURSOR_REPEATED",
  "PROOF_NAME_NOT_IN_ISSUER",
  "MAILBOX_CURSOR_REPEATED",
  "EVENT_COUNT_MISMATCH",
  "MESSAGE_COUNT_MISMATCH",
  "EVENT_KEYS_WITHOUT_STATE",
  "STATE_KEYS_WITHOUT_EVENT",
  "NEWEST_MESSAGE_MISSING",
]);

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })
);

export const MailboxCounts = Schema.Struct({ events: Count, messages: Count });

export const AssertionCounts = Schema.Struct({
  actual: Schema.optionalKey(Count),
  expected: Schema.optionalKey(Count),
  mailboxIndex: Schema.optionalKey(Count),
});

export type AssertionCountsValue = typeof AssertionCounts.Type;

export class ProofAssertionFailure extends Schema.TaggedError<ProofAssertionFailure>()(
  "ProofAssertionFailure",
  {
    ...AssertionCounts.fields,
    assertionCode: AssertionCode,
  }
) {}

export const requireIssuerName = (
  entry: { readonly did: string } | undefined
) =>
  entry === undefined
    ? Effect.fail(
        new ProofAssertionFailure({ assertionCode: "PROOF_NAME_NOT_IN_ISSUER" })
      )
    : Effect.succeed(entry.did);

export const requireMailboxCounts = (
  expected: typeof MailboxCounts.Type,
  actual: typeof MailboxCounts.Type,
  mailboxIndex: number
): void => {
  if (expected.events !== actual.events) {
    throw new ProofAssertionFailure({
      actual: actual.events,
      assertionCode: "EVENT_COUNT_MISMATCH",
      expected: expected.events,
      mailboxIndex,
    });
  }

  if (expected.messages !== actual.messages) {
    throw new ProofAssertionFailure({
      actual: actual.messages,
      assertionCode: "MESSAGE_COUNT_MISMATCH",
      expected: expected.messages,
      mailboxIndex,
    });
  }
};
