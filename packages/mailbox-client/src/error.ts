import { TransportFailure } from "@rat-king/lexicon/transport-failure";
import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Predicate, Schema } from "effect";
import { HttpClientError } from "effect/http";

export class MailboxClientError extends Schema.TaggedError<MailboxClientError>()(
  "MailboxClientError",
  {
    error: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    status: Schema.optionalKey(Schema.Finite),
  }
) {}

export const connectionFailure = (failure: { readonly _tag: string }) =>
  (HttpClientError.isHttpClientError(failure) &&
    Predicate.isTagged(failure.reason, "TransportError")) ||
  Predicate.isTagged(failure, "TimeoutError");

export const clientError = (failure: { readonly _tag: string }) => {
  if (Schema.is(MailboxClientError)(failure)) {
    return failure;
  }

  if (
    connectionFailure(failure) ||
    (Schema.is(TransportFailure)(failure) &&
      failure.reason === "Service-auth HTTP connection unavailable")
  ) {
    return new MailboxClientError({
      error: "MailboxUnavailable",
      reason: "Mailbox connection failed",
    });
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
