import { Cause, Effect, Option, Schema } from "effect";

import {
  AssertionCode,
  AssertionCounts,
} from "./restore-drill-proof-assertion.ts";
import type { AssertionCountsValue } from "./restore-drill-proof-assertion.ts";
import type { ProtocolCode } from "./restore-drill-proof-http.ts";
import { protocolErrorCode } from "./restore-drill-proof-http.ts";

export {
  AssertionCode,
  AssertionCounts,
  ProofAssertionFailure,
} from "./restore-drill-proof-assertion.ts";

export {
  ProofHttpFailure,
  ProtocolErrorBody,
  protocolErrorCode,
} from "./restore-drill-proof-http.ts";

export const ProofStep = Schema.Literals([
  "bootstrap",
  "namespace",
  "inventory",
  "auth-manifest",
  "auth-fixture",
  "reload",
  "resolve-name",
  "resolve-lease",
  "fetch-events",
  "compare-counts",
  "message-readback",
  "write-proof",
  "restore-auth",
  "restore-reload",
  "evict",
]);

export interface ProofProgress {
  readonly lastOk: typeof ProofStep.Type | "none";
  readonly step: typeof ProofStep.Type;
}

export interface ProofFailure extends ProofProgress, AssertionCountsValue {
  readonly assertionCode?: typeof AssertionCode.Type | undefined;
  readonly causeKind: "Fail" | "Die" | "Interrupt" | "Empty" | "Thrown";
  readonly code: string;
  readonly errorKind: string;
  readonly kind: string;
  readonly phase: "primary" | "cleanup";
  readonly status?: number | undefined;
  readonly tag?: string | undefined;
  readonly xrpcError?: typeof ProtocolCode.Type | undefined;
}

const initialProgress: ProofProgress = { lastOk: "none", step: "bootstrap" };

const Status = Schema.Int.check(
  Schema.isBetween({ maximum: 599, minimum: 100 })
);

const Response = Schema.Struct({ status: Schema.optionalKey(Status) });

const Reason = Schema.Struct({ response: Schema.optionalKey(Response) });

const Fields = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  assertionCode: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.Union([Schema.String, Reason])),
  response: Schema.optionalKey(Response),
  status: Schema.optionalKey(Status),
});

const Rejected = Schema.Struct({
  _tag: Schema.Literal("Rejected"),
  error: Fields,
});

const ForeignFault = Schema.Union([
  Schema.Cause(Schema.Unknown, Schema.Unknown),
  Schema.ErrorInstance(),
  Rejected,
  Fields,
]);

const emptyFields: typeof Fields.Type = {};

const allowedTags = Schema.Literals([
  "ProofHttpFailure",
  "ProofAssertionFailure",
  "MailboxClientError",
  "XrpcFailure",
  "HttpClientError",
  "RequestError",
  "ResponseError",
  "TimeoutError",
  "SchemaError",
  "PlatformError",
]);

const causeCodes = {
  Die: "EFFECT_DIE",
  Empty: "EFFECT_EMPTY_CAUSE",
  Fail: "EFFECT_FAIL",
  Interrupt: "EFFECT_INTERRUPT",
  Thrown: "UNEXPECTED_THROW",
} as const;

const causeKind = (cause: unknown): ProofFailure["causeKind"] => {
  if (!Cause.isCause(cause)) {
    return "Thrown";
  }

  if (cause.reasons.some(Cause.isFailReason)) {
    return "Fail";
  }

  if (cause.reasons.some(Cause.isDieReason)) {
    return "Die";
  }

  if (cause.reasons.some(Cause.isInterruptReason)) {
    return "Interrupt";
  }

  return "Empty";
};

const failureCode = (
  kind: ProofFailure["causeKind"],
  rejected: boolean,
  tag: string | undefined
): string => {
  if (rejected) {
    return "XRPC_REJECTED";
  }

  if (kind === "Thrown" && tag === "ProofHttpFailure") {
    return "HTTP_FAILURE";
  }

  if (kind === "Thrown" && tag === "ProofAssertionFailure") {
    return "ASSERTION_FAILED";
  }

  return causeCodes[kind];
};

export const proofFailureMetadata = (
  phase: ProofFailure["phase"],
  cause: unknown,
  progress: ProofProgress = initialProgress
): ProofFailure => {
  const parsed = Schema.decodeUnknownOption(ForeignFault)(cause);
  const fault = Option.getOrUndefined(parsed);

  const category = causeKind(fault);
  const squashed = Cause.isCause(fault) ? Cause.squash(fault) : fault;

  const rejected = Schema.is(Rejected)(squashed);
  let detail = emptyFields;

  if (rejected) {
    detail = squashed.error;
  } else if (Schema.is(Fields)(squashed)) {
    detail = squashed;
  }

  const tag = Schema.is(allowedTags)(detail._tag) ? detail._tag : undefined;
  const reason = Schema.is(Reason)(detail.reason) ? detail.reason : undefined;

  const status =
    detail.status ?? detail.response?.status ?? reason?.response?.status;

  const assertionCode = Schema.is(AssertionCode)(detail.assertionCode)
    ? detail.assertionCode
    : undefined;

  const comparison =
    tag === "ProofAssertionFailure"
      ? Option.getOrUndefined(
          Schema.decodeUnknownOption(AssertionCounts)(squashed)
        )
      : undefined;

  const names = new Set([
    "Error",
    "TypeError",
    "FetchError",
    "HttpClientError",
    "TimeoutError",
  ]);

  const errorKind =
    squashed instanceof Error && names.has(squashed.name)
      ? squashed.name
      : "Unknown";

  const code = failureCode(category, rejected, tag);

  return {
    ...progress,
    ...comparison,
    assertionCode,
    causeKind: category,
    code,
    errorKind,
    kind: code,
    phase,
    status,
    tag,
    xrpcError: protocolErrorCode(detail.error),
  };
};

export const createProofProgress = <E, R>(
  report: (progress: ProofProgress) => Effect.Effect<void, E, R>
) => {
  let progress: ProofProgress = initialProgress;

  const run = Effect.fn("proofProgress.run")(function* run<A, E2, R2>(
    step: typeof ProofStep.Type,
    work: Effect.Effect<A, E2, R2>
  ) {
    progress = { ...progress, step };
    yield* report(progress);
    const result = yield* work;

    progress = { lastOk: step, step };
    yield* report(progress);

    return result;
  });

  return {
    run,
    snapshot: (): ProofProgress => ({ ...progress }),
  };
};

export const withProofCleanup = <A, E, R, E2, R2, E3, R3>(
  work: Effect.Effect<A, E, R>,
  cleanup: Effect.Effect<void, E2, R2>,
  report: (failure: ProofFailure) => Effect.Effect<void, E3, R3>,
  progress: () => ProofProgress = () => initialProgress
): Effect.Effect<A, E | E2, R | R2 | R3> => {
  const notify = (phase: ProofFailure["phase"], cause: Cause.Cause<unknown>) =>
    Effect.ignoreCause(report(proofFailureMetadata(phase, cause, progress())));

  const release = cleanup.pipe(
    Effect.tapCause((cause) => notify("cleanup", cause))
  );

  return work.pipe(
    Effect.tapCause((cause) =>
      notify("primary", cause).pipe(Effect.andThen(Effect.ignoreCause(release)))
    ),
    Effect.tap(() => release)
  );
};
