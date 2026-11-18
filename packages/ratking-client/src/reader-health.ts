import { DateTime, Option, Predicate, Schema } from "effect";

import { AgentName } from "./name.ts";
import { RetrySnapshot } from "./retry-counters.ts";

export const READER_STUCK_MS = 300_000;

export const HEARTBEAT_EVERY = "1 minute";

const At = Schema.DateTimeUtcFromString;

const ErrorTag = Schema.String.check(
  Schema.isPattern(/^[A-Za-z]{1,64}(?:\/[A-Za-z]{1,64})?$/u)
);

export const ReaderHeartbeat = Schema.Struct({
  acquisitionSince: Schema.optionalKey(At),
  generation: Schema.optionalKey(Schema.Int),
  lastConsumeOk: Schema.NullOr(At),
  lastError: Schema.NullOr(ErrorTag),
  lastReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
  leaseHeldSince: Schema.NullOr(At),
  leaseTtlMs: Schema.optionalKey(Schema.Int),
  leaseUntil: Schema.optionalKey(Schema.NullOr(At)),
  name: AgentName,
  owner: Schema.optionalKey(AgentName),
  pid: Schema.Int,
  retries: Schema.optionalKey(RetrySnapshot),
  session: Schema.optionalKey(Schema.String),
  startedAt: At,
  state: Schema.Literals([
    "Starting",
    "Minting",
    "Acquiring",
    "Live",
    "Retrying",
    "Refused",
    "SendOnly",
  ]),
  updatedAt: At,
});

export type ReaderHeartbeatValue = typeof ReaderHeartbeat.Type;

export const HeartbeatJson = Schema.fromJsonString(ReaderHeartbeat);

const Coded = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export const errorTag = (error: { readonly _tag: string }) => {
  const coded = Schema.is(Coded)(error) ? (error.error ?? error.code) : null;

  return Predicate.isString(coded) && /^[A-Za-z]{1,64}$/u.test(coded)
    ? `${error._tag}/${coded}`
    : error._tag;
};

export type ReaderVerdict = "running" | "stuck" | "stale";

export const readerVerdict = (
  beat: ReaderHeartbeatValue,
  alive: boolean,
  now: number
): ReaderVerdict => {
  if (!alive) {
    return "stale";
  }

  const progress = DateTime.toEpochMillis(beat.lastConsumeOk ?? beat.startedAt);

  return now - progress > READER_STUCK_MS ? "stuck" : "running";
};

export const heldReason = (name: string) =>
  `name ${name} is held by another live Pi; not reading`;

export const blockedByAncestor = (
  heartbeat: Option.Option<ReaderHeartbeatValue>,
  ancestors: readonly number[],
  session: string,
  alive: (pid: number) => boolean
) =>
  Option.exists(
    heartbeat,
    (beat) =>
      beat.session !== session &&
      ancestors.includes(beat.pid) &&
      alive(beat.pid)
  );
