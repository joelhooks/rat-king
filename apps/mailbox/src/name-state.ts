import { Schema } from "effect";

import { Retirement } from "./store.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const NameState = Schema.Struct({
  did: Schema.NonEmptyString.check(Schema.isStartingWith("did:web:")),
  leaseExpiresAt: Count,
  leaseGeneration: Count,
  observedAt: Count,
  retirement: Schema.NullOr(Retirement),
  version: Count,
});

export type NameStateValue = typeof NameState.Type;

export const NameCommand = Schema.TaggedUnion({
  Clear: { name: Schema.NonEmptyString },
  Repoint: { successor: Schema.NonEmptyString, updatedAt: Count },
  Retire: { holderMayRetire: Schema.Boolean, retirement: Retirement },
});

export type NameCommandValue = typeof NameCommand.Type;

export const Ticket = Schema.Struct({
  command: NameCommand,
  did: NameState.fields.did,
  expectedVersion: Count,
  opId: Schema.NonEmptyString,
});

export type TicketValue = typeof Ticket.Type;

export const TicketOutcome = Schema.TaggedUnion({
  Applied: { cleared: Schema.Boolean },
  Refused: {
    error: Schema.Literals(["NameNotFound", "LeaseLive", "NotRetired"]),
    message: Schema.String,
  },
  Superseded: {},
});

export const TicketReply = Schema.Struct({
  outcome: TicketOutcome,
  state: NameState,
});

export type TicketReplyValue = typeof TicketReply.Type;

export const observedStatus = (
  state: NameStateValue | undefined,
  now: number
) => {
  if (state === undefined) {
    return "unknown";
  }

  if (state.retirement !== null) {
    return "retired";
  }

  return state.leaseExpiresAt > now ? "live" : "idle";
};
