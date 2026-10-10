import { Clock, Console, Effect, Option, Ref, Schedule } from "effect";
import type { SnapshotFrom } from "xstate";
import { initialTransition, transition } from "xstate";

import type { ShipReceipt } from "./ship-config.ts";
import { sanitizeCandidateStderr } from "./ship-diagnostics.ts";
import { shipMachine } from "./ship-machine.ts";
import type { ShipEvent } from "./ship-machine.ts";
import type { FleetError } from "./stage-config.ts";

export type ShipSnapshot = SnapshotFrom<typeof shipMachine>;

export interface ShipPorts<R = never> {
  readonly fetch: Effect.Effect<string, FleetError, R>;
  readonly ci: (sha: string) => Effect.Effect<boolean, FleetError, R>;
  readonly deploy: (
    sha: string
  ) => Effect.Effect<
    Pick<
      typeof ShipReceipt.Type,
      "result" | "celldRestarted" | "restartSeconds" | "retryAt" | "stderrTail"
    >,
    FleetError,
    R
  >;
  readonly checkpoint: (
    snapshot: Pick<ShipSnapshot["context"], "failed" | "successful"> &
      Partial<Pick<ShipSnapshot["context"], "deferred" | "retryAt">>
  ) => Effect.Effect<void, FleetError, R>;
  readonly record: (
    receipt: typeof ShipReceipt.Type
  ) => Effect.Effect<void, FleetError, R>;
  readonly notify: (
    receipt: typeof ShipReceipt.Type
  ) => Effect.Effect<void, FleetError, R>;
}

const advance = (snapshot: ShipSnapshot, event: ShipEvent) =>
  transition(shipMachine, snapshot, event)[0];

export const shipCycle = Effect.fn("Ship.cycle")(function* shipCycle<R>(
  snapshot: ShipSnapshot,
  ports: ShipPorts<R>
) {
  let current = advance(snapshot, { type: "tick" });
  const fetched = yield* ports.fetch.pipe(Effect.option);

  if (Option.isNone(fetched)) {
    yield* Console.error("SHIP_FETCH_FAILED");

    return advance(current, { type: "fetchFailed" });
  }

  current = advance(current, {
    now: (yield* Clock.currentTimeMillis) / 1000,
    sha: fetched.value,
    type: "observed",
  });

  if (!current.matches("waiting-ci")) {
    return current;
  }

  if (
    !(yield* ports
      .ci(current.context.sha)
      .pipe(Effect.orElseSucceed(() => false)))
  ) {
    return advance(current, { type: "pending" });
  }

  current = advance(current, { type: "ready" });
  const start = (yield* Clock.currentTimeMillis) / 1000;
  const { sha } = current.context;
  yield* ports.checkpoint({
    failed: sha,
    successful: current.context.successful,
  });

  const deployed = yield* ports.deploy(sha).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        celldRestarted: null,
        restartSeconds: null,
        result: "failed" as const,
        stderrTail: sanitizeCandidateStderr(error.reason),
      })
    )
  );

  const receipt = {
    ...deployed,
    end: (yield* Clock.currentTimeMillis) / 1000,
    sha,
    start,
  };

  yield* ports.record(receipt);
  current =
    deployed.result === "deferred"
      ? advance(current, { retryAt: deployed.retryAt ?? 0, type: "deferred" })
      : advance(current, {
          type: deployed.result === "failed" ? "failure" : "success",
        });
  yield* ports.checkpoint(current.context);
  yield* ports
    .notify(receipt)
    .pipe(
      Effect.catch((error) =>
        Console.error(
          `SHIP_NOTIFICATION_FAILED sha=${sha.slice(0, 12)}: ${error.reason}; deploy receipt preserved`
        )
      )
    );

  return current;
});

export const shipLoop = <R>(
  ports: ShipPorts<R>,
  saved: Pick<ShipSnapshot["context"], "failed" | "successful"> &
    Partial<Pick<ShipSnapshot["context"], "deferred" | "retryAt">>,
  intervalSeconds: number,
  drifted: Effect.Effect<boolean, never, R>
) =>
  Effect.gen(function* runShipLoop() {
    const state = yield* Ref.make(initialTransition(shipMachine, saved)[0]);
    yield* Effect.gen(function* cycle() {
      const next = yield* shipCycle(yield* Ref.get(state), ports);
      yield* Ref.set(state, next);
      yield* Console.log(
        JSON.stringify({ sha: next.context.sha, state: next.value })
      );

      return yield* drifted;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(`${intervalSeconds} seconds`),
        until: (stale) => stale,
      })
    );
    yield* Console.log(
      JSON.stringify({ runner: "code changed; exiting for launchd restart" })
    );
  });
