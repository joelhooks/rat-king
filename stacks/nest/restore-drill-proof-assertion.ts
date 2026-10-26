import { Schema } from "effect";

export const AssertionCode = Schema.Literals([
  "NAMESPACE_NOT_PRIVATE",
  "MISSING_BINDING",
  "EXPECTED_KEYPAIR",
  "NAME_CURSOR_REPEATED",
  "MAILBOX_CURSOR_REPEATED",
  "EVENT_COUNT_MISMATCH",
  "MESSAGE_COUNT_MISMATCH",
  "NEWEST_MESSAGE_MISSING",
]);

export class ProofAssertionFailure extends Schema.TaggedError<ProofAssertionFailure>()(
  "ProofAssertionFailure",
  {
    assertionCode: AssertionCode,
  }
) {}
