import { Schema } from "effect";

export const ProtocolCode = Schema.Literals([
  "NameNotFound",
  "LeaseNotFound",
  "InvalidRequest",
  "InvalidToken",
  "ExpiredToken",
  "AuthenticationRequired",
  "AuthorizationRequired",
  "Forbidden",
  "InternalServerError",
  "NotFound",
  "RateLimitExceeded",
]);

export class ProofHttpFailure extends Schema.TaggedError<ProofHttpFailure>()(
  "ProofHttpFailure",
  {
    error: Schema.optionalKey(ProtocolCode),
    status: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 100 })),
  }
) {}

export const protocolErrorCode = (
  value: string | undefined
): typeof ProtocolCode.Type | undefined =>
  Schema.is(ProtocolCode)(value) ? value : undefined;

export const ProtocolErrorBody = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
});
