import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Schema } from "effect";

export class MailboxClientError extends Schema.TaggedError<MailboxClientError>()(
  "MailboxClientError",
  {
    error: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    status: Schema.optionalKey(Schema.Finite),
  }
) {}

export const clientError = (failure: { readonly _tag: string }) => {
  if (Schema.is(MailboxClientError)(failure)) {
    return failure;
  }

  if (Schema.is(XrpcFailure)(failure)) {
    return new MailboxClientError({
      error: failure.error,
      reason: failure.message ?? "Mailbox XRPC call failed",
      status: failure.status,
    });
  }

  return new MailboxClientError({ reason: "Mailbox operation failed" });
};
