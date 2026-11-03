import { DateTime, Option, Schema } from "effect";

import { Turn } from "../../packages/lexicon/turns.ts";
import type { TurnValue } from "../../packages/lexicon/turns.ts";
import type { ReaderHeartbeatValue } from "../../packages/ratking-client/src/reader-health.ts";
import { readerRecovering } from "./alarm-reader-windows.ts";
import type { ReaderWindowFacts } from "./alarm-reader-windows.ts";

export const crashedReader = (
  beat: ReaderHeartbeatValue,
  now: number,
  windows: ReaderWindowFacts = {}
): TurnValue | undefined => {
  if (
    beat.owner === undefined ||
    beat.session === undefined ||
    beat.generation === undefined
  ) {
    return undefined;
  }

  const expiredAt =
    beat.leaseUntil === undefined || beat.leaseUntil === null
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(beat.leaseUntil);

  const acquiringAt =
    beat.state === "Acquiring" &&
    beat.acquisitionSince !== undefined &&
    beat.leaseTtlMs !== undefined
      ? DateTime.toEpochMillis(beat.acquisitionSince) + beat.leaseTtlMs + 10_000
      : Number.POSITIVE_INFINITY;

  const expired = now >= expiredAt;
  const acquiring = now >= acquiringAt;

  if (!expired && !acquiring) {
    return undefined;
  }

  const since = expired ? expiredAt : acquiringAt;

  if (readerRecovering(since, windows, now)) {
    return undefined;
  }

  const record = {
    $type: "sh.mschf.agentgraph.turn",
    agent: beat.name,
    at: DateTime.formatIso(DateTime.makeUnsafe(now)),
    generation: beat.generation,
    reason: expired
      ? "Reader lease lapsed"
      : "Reader acquiring beyond lease TTL plus 10 seconds",
    session: beat.session,
    state: "crashed",
    turnId: `${beat.session}:0`,
    version: "0.1",
  };

  return Schema.decodeUnknownOption(Turn)(record).pipe(Option.getOrUndefined);
};
