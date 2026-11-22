import { Effect, Option } from "effect";

import type { PreparedFleetPayload } from "./prepared-payload.ts";
import type { ShipCheckpoint } from "./ship-config.ts";
import type { FleetError } from "./stage-config.ts";

export interface PreparedEvidence<R = never> {
  readonly eligible: Effect.Effect<ReadonlySet<string>, FleetError, R>;
  readonly head: Effect.Effect<string, FleetError, R>;
  readonly firstParent: (
    sha: string
  ) => Effect.Effect<string | undefined, FleetError, R>;
  readonly fence: (sha: string) => Effect.Effect<boolean, FleetError, R>;
  readonly artifact: (
    sha: string
  ) => Effect.Effect<PreparedFleetPayload, FleetError, R>;
}

export const maxFirstParents = 256;

const aheadOfCheckpoint = Effect.fn("Ship.proveFirstParents")(
  function* aheadOfCheckpoint<R>(
    evidence: PreparedEvidence<R>,
    checkpoint: string
  ) {
    let sha: string | undefined = yield* evidence.head;
    const ahead: string[] = [];
    const seen = new Set<string>();

    while (sha !== undefined && ahead.length <= maxFirstParents) {
      if (sha === checkpoint) {
        return ahead;
      }

      if (seen.has(sha) || ahead.length === maxFirstParents) {
        break;
      }

      seen.add(sha);
      ahead.push(sha);
      sha = yield* evidence.firstParent(sha);
    }

    return [];
  }
);

export interface PreparedSelection {
  readonly ahead: readonly string[];
  readonly payload: PreparedFleetPayload;
}

const retryAt = (saved: typeof ShipCheckpoint.Type, sha: string) =>
  Math.max(
    saved.preparedRetries?.[sha] ?? 0,
    sha === saved.deferred ? (saved.retryAt ?? 0) : 0
  );

export const selectPrepared = Effect.fn("Ship.selectPrepared")(
  function* selectPrepared<R>(
    evidence: PreparedEvidence<R>,
    saved: typeof ShipCheckpoint.Type,
    now: number
  ) {
    if (saved.successful === "") {
      return Option.none<PreparedSelection>();
    }

    const eligible = yield* evidence.eligible;

    if (eligible.size === 0) {
      return Option.none<PreparedSelection>();
    }

    const ahead = yield* aheadOfCheckpoint(evidence, saved.successful);

    for (const sha of ahead) {
      if (sha === saved.failed) {
        break;
      }

      if (
        eligible.has(sha) &&
        retryAt(saved, sha) <= now &&
        (yield* evidence.fence(sha).pipe(Effect.orElseSucceed(() => false)))
      ) {
        const verified = yield* evidence.artifact(sha).pipe(Effect.option);

        if (Option.isSome(verified) && verified.value.commit === sha) {
          return Option.some<PreparedSelection>({
            ahead,
            payload: verified.value,
          });
        }
      }
    }

    return Option.none<PreparedSelection>();
  },
  (effect) =>
    effect.pipe(Effect.orElseSucceed(() => Option.none<PreparedSelection>()))
);
