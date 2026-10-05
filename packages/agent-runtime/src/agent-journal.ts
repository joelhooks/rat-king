import * as Defs from "@rat-king/lexicon/defs";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import { SubmissionId } from "./port.ts";
import type { HarnessFailure } from "./port.ts";

export const Journal = Schema.TaggedUnion({
  acked: {},
  answered: { answer: Schema.String, replyId: Schema.String },
  failed: { reason: Schema.String },
  pending: { replyId: Schema.String },
  replied: {},
  sealed: { envelope: Defs.EncryptedEnvelope },
  submitted: { id: SubmissionId, replyId: Schema.String },
  unanswered: { reason: Schema.String },
});

export type JournalValue = typeof Journal.Type;

export interface LoopJournal {
  readonly read: (
    requestId: string
  ) => Effect.Effect<JournalValue | undefined, HarnessFailure>;
  readonly replyId: () => Effect.Effect<string, HarnessFailure>;
  readonly write: (
    requestId: string,
    value: JournalValue
  ) => Effect.Effect<void, HarnessFailure>;
}

export class AgentJournal extends Context.Service<AgentJournal, LoopJournal>()(
  "@rat-king/AgentJournal"
) {}
