// @effect-diagnostics asyncFunction:off -- Promise ports for the standalone isolated proof subprocess.
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { AssertionCode } from "./restore-drill-proof-assertion.ts";
import type { ProtocolCode } from "./restore-drill-proof-http.ts";
import { protocolErrorCode } from "./restore-drill-proof-http.ts";

export {
  AssertionCode,
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

export class ProofEffectFailure extends Schema.TaggedError<ProofEffectFailure>()(
  "ProofEffectFailure",
  {
    effectCause: Schema.Cause(Schema.Unknown, Schema.Unknown),
  }
) {}

export interface ProofProgress {
  readonly lastOk: typeof ProofStep.Type | "none";
  readonly step: typeof ProofStep.Type;
}

export interface ProofFailure extends ProofProgress {
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
  ProofEffectFailure,
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

  const effectCause = Schema.is(ProofEffectFailure)(fault)
    ? fault.effectCause
    : fault;

  const category = causeKind(effectCause);

  const squashed = Cause.isCause(effectCause)
    ? Cause.squash(effectCause)
    : effectCause;

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

export const runProofEffect = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isFailure(exit)) {
    throw new ProofEffectFailure({ effectCause: exit.cause });
  }

  return exit.value;
};

export const createProofProgress = (
  report: (progress: ProofProgress) => Promise<void>
) => {
  let progress: ProofProgress = initialProgress;

  return {
    run: async <A>(
      step: typeof ProofStep.Type,
      work: () => A | Promise<A>
    ): Promise<A> => {
      progress = { ...progress, step };
      await report(progress);
      const result = await work();

      progress = { lastOk: step, step };
      await report(progress);

      return result;
    },
    snapshot: (): ProofProgress => ({ ...progress }),
  };
};

export const withProofCleanup = async <A>(
  work: () => Promise<A>,
  cleanup: () => Promise<void>,
  report: (failure: ProofFailure) => Promise<void>,
  progress: () => ProofProgress = () => initialProgress
): Promise<A> => {
  const notify = async (phase: ProofFailure["phase"], cause: unknown) => {
    try {
      await report(proofFailureMetadata(phase, cause, progress()));

      return true;
    } catch {
      return false;
    }
  };

  const release = async () => {
    try {
      await cleanup();
    } catch (error) {
      await notify("cleanup", error);

      throw error;
    }
  };

  let result: A;

  try {
    result = await work();
  } catch (error) {
    await notify("primary", error);
    await release().catch(() => null);

    throw error;
  }

  await release();

  return result;
};
