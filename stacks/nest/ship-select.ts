import { Effect, Option, Result } from "effect";

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

    while (sha !== undefined) {
      if (sha === checkpoint) {
        return { ahead, reason: "" };
      }

      if (seen.has(sha) || ahead.length === maxFirstParents) {
        return {
          ahead: [],
          reason:
            "BeyondFirstParentLimit: checkpoint not proven within 256 commits",
        };
      }

      seen.add(sha);
      ahead.push(sha);
      sha = yield* evidence.firstParent(sha);
    }

    return { ahead: [], reason: "CheckpointNotFirstParent" };
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

export const preparedBackoff = () => {
  const attempts = new Map<
    string,
    { readonly reason: string; readonly count: number; readonly until: number }
  >();

  return {
    clear: (sha: string) => attempts.delete(sha),
    fail: (sha: string, now: number, reason: string) => {
      if (!attempts.has(sha) && attempts.size >= maxFirstParents * 2) {
        attempts.delete(attempts.keys().next().value ?? "");
      }

      const count = Math.min(5, (attempts.get(sha)?.count ?? 0) + 1);

      attempts.set(sha, {
        count,
        reason,
        until: now + Math.min(1800, 120 * 2 ** (count - 1)),
      });
    },
    waiting: (sha: string, now: number) => {
      const entry = attempts.get(sha);

      return entry !== undefined && entry.until > now
        ? entry.reason
        : undefined;
    },
  };
};

const readiness = Effect.fn("Ship.candidateReadiness")(function* readiness<R>(
  evidence: PreparedEvidence<R>,
  sha: string
) {
  const fenced = yield* evidence.fence(sha).pipe(Effect.result);

  if (Result.isFailure(fenced)) {
    return { reason: fenced.failure.reason };
  }

  if (!fenced.success) {
    return { reason: "ExactFenceNotGreen" };
  }

  const artifact = yield* evidence.artifact(sha).pipe(Effect.result);

  if (Result.isFailure(artifact)) {
    return { reason: artifact.failure.reason };
  }

  return artifact.success.commit === sha
    ? { payload: artifact.success }
    : { reason: "ArtifactShaMismatch" };
});

const walkEligible = Effect.fn("Ship.walkEligible")(function* walkEligible<R>(
  evidence: PreparedEvidence<R>,
  saved: typeof ShipCheckpoint.Type,
  ahead: readonly string[],
  eligible: ReadonlySet<string>,
  now: number,
  hold: ((sha: string, reason: string) => void) | undefined,
  backoff: ReturnType<typeof preparedBackoff>
) {
  const known = new Set(ahead);

  for (const sha of eligible) {
    if (sha === saved.successful) {
      break;
    }

    if (!known.has(sha)) {
      hold?.(sha, "NotAheadOnFirstParent");
    }
  }

  for (const sha of ahead) {
    if (sha === saved.failed) {
      hold?.(sha, "DeployFailureBarrier");
      break;
    }

    if (!eligible.has(sha)) {
      continue;
    }

    const waiting = backoff.waiting(sha, now);

    if (waiting !== undefined || retryAt(saved, sha) > now) {
      hold?.(sha, waiting ?? "RestartDeferred");
      continue;
    }

    const candidate = yield* readiness(evidence, sha);

    if (candidate.payload !== undefined) {
      backoff.clear(sha);

      return Option.some<PreparedSelection>({
        ahead,
        payload: candidate.payload,
      });
    }

    backoff.fail(sha, now, candidate.reason);
    hold?.(sha, candidate.reason);
  }

  return Option.none<PreparedSelection>();
});

export const selectPrepared = Effect.fn("Ship.selectPrepared")(
  function* selectPrepared<R>(
    evidence: PreparedEvidence<R>,
    saved: typeof ShipCheckpoint.Type,
    now: number,
    hold?: (sha: string, reason: string) => void,
    backoff = preparedBackoff()
  ) {
    if (saved.successful === "") {
      hold?.("", "MissingSuccessfulCheckpoint");

      return Option.none<PreparedSelection>();
    }

    const eligible = yield* evidence.eligible.pipe(Effect.result);

    if (Result.isFailure(eligible)) {
      hold?.("", eligible.failure.reason);

      return Option.none<PreparedSelection>();
    }

    if (eligible.success.size === 0) {
      hold?.("", "NoPinnedCandidates");

      return Option.none<PreparedSelection>();
    }

    const proof = yield* aheadOfCheckpoint(evidence, saved.successful).pipe(
      Effect.result
    );

    if (Result.isFailure(proof) || proof.success.reason !== "") {
      const reason = Result.isFailure(proof)
        ? proof.failure.reason
        : proof.success.reason;

      for (const sha of eligible.success) {
        if (sha === saved.successful) {
          break;
        }

        hold?.(sha, reason);
      }

      hold?.("", reason);

      return Option.none<PreparedSelection>();
    }

    return yield* walkEligible(
      evidence,
      saved,
      proof.success.ahead,
      eligible.success,
      now,
      hold,
      backoff
    );
  }
);
