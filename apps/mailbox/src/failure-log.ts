/* oxlint-disable typescript/promise-function-async -- Effect adapters require lazy Promise thunks. */
import { lexString } from "@rat-king/lexicon/runtime";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { getClaimsDiagnostics } from "@rat-king/mailbox-client/auth";
import { Effect, Option, Schema } from "effect";

import { base64url } from "./auth.ts";
import { errorResponse } from "./failure.ts";

export interface FailureScope {
  method: string;
  recipient?: string;
  seq?: number;
}

type ClaimsDiagnostics = NonNullable<ReturnType<typeof getClaimsDiagnostics>>;

interface FailureFields {
  error: string;
  method: string;
  status: number;
  check?: ClaimsDiagnostics["check"];
  claimedIssuer?: string;
  detail?: string;
  recipient?: string;
  seq?: number;
}

const ErrorBody = Schema.Struct({
  error: Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,64}$/u)),
  message: Schema.optionalKey(Schema.String),
});

const isDid = Schema.is(lexString({ format: "did", type: "string" }));

const recipientHash = (did: string) =>
  Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(did))
  ).pipe(
    Effect.map((digest) => base64url(new Uint8Array(digest).slice(0, 9))),
    Effect.orElseSucceed(() => "unavailable")
  );

export const logFailure = Effect.fn("Mailbox.logFailure")(function* logFailure(
  scope: FailureScope,
  response: Response,
  claims?: ClaimsDiagnostics
) {
  if (response.status < 400) {
    return;
  }

  const body = yield* Effect.tryPromise(() => response.clone().text()).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorBody))
    ),
    Effect.option
  );

  const detail = body.pipe(
    Option.flatMap(({ error, message }) =>
      message === undefined || message === error
        ? Option.none()
        : Option.some(message.slice(0, 120))
    )
  );

  const fields: FailureFields = {
    error: body.pipe(
      Option.map(({ error }) => error),
      Option.getOrElse(() => "Unknown")
    ),
    method: scope.method,
    status: response.status,
  };

  if (Option.isSome(detail)) {
    fields.detail = detail.value;
  }

  if (claims !== undefined) {
    fields.check = claims.check;

    if (isDid(claims.claimedIssuer)) {
      fields.claimedIssuer = claims.claimedIssuer;
    }
  }

  if (scope.recipient !== undefined) {
    fields.recipient = yield* recipientHash(scope.recipient);
  }

  if (scope.seq !== undefined) {
    fields.seq = scope.seq;
  }

  yield* Effect.logWarning("Mailbox XRPC failure").pipe(
    Effect.annotateLogs({ ...fields })
  );
});

export const respondToFailure = (scope: FailureScope, error: XrpcFailure) => {
  const response = errorResponse(error);

  return logFailure(scope, response, getClaimsDiagnostics(error)).pipe(
    Effect.as(response)
  );
};

export const logSocketClaimsFailure = (method: string, error: XrpcFailure) => {
  const claims = getClaimsDiagnostics(error);

  return claims === undefined
    ? Effect.void
    : logFailure({ method }, errorResponse(error), claims);
};
