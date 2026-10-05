import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { HarnessFailure } from "./failure.ts";

export const RequestId = Schema.NonEmptyString.pipe(
  Schema.brand("AgentRequestId")
);

export type RequestIdValue = typeof RequestId.Type;

export const SubmissionId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("AgentSubmissionId")
);

export type SubmissionIdValue = typeof SubmissionId.Type;

export const Input = Schema.Struct({
  content: Schema.NonEmptyString,
  requestId: RequestId,
});

export type InputValue = typeof Input.Type;

export const Settlement = Schema.TaggedUnion({
  Done: { answer: Schema.String, id: SubmissionId },
  Unanswered: { id: SubmissionId, reason: Schema.String },
});

export type SettlementValue = typeof Settlement.Type;

export class AgentHarness extends Context.Service<
  AgentHarness,
  {
    readonly submit: (
      input: InputValue
    ) => Effect.Effect<SubmissionIdValue, HarnessFailure>;
    readonly wait: (
      id: SubmissionIdValue
    ) => Effect.Effect<SettlementValue, HarnessFailure>;
    readonly resume: () => Effect.Effect<void, HarnessFailure>;
  }
>()("@rat-king/AgentHarness") {}

export { HarnessFailure } from "./failure.ts";
