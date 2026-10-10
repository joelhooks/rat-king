import { Clock, Console, Effect, Option, Ref, Schedule } from "effect";
import type { SnapshotFrom } from "xstate";
import { initialTransition, transition } from "xstate";

import type { ShipReceipt } from "./ship-config.ts";
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
      "result" | "celldRestarted" | "restartSeconds"
    >,
    FleetError,
    R
  >;
  readonly checkpoint: (
    snapshot: Pick<ShipSnapshot["context"], "failed" | "successful">
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

  current = advance(current, { sha: fetched.value, type: "observed" });

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
    Effect.orElseSucceed(() => ({
      celldRestarted: null,
      restartSeconds: null,
      result: "failed" as const,
    }))
  );

  const receipt = {
    ...deployed,
    end: (yield* Clock.currentTimeMillis) / 1000,
    sha,
    start,
  };

  yield* ports.record(receipt);
  current = advance(current, {
    type: deployed.result === "failed" ? "failure" : deployed.result,
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
  saved: Pick<ShipSnapshot["context"], "failed" | "successful">,
  intervalSeconds: number
) =>
  Effect.gen(function* runShipLoop() {
    const state = yield* Ref.make(initialTransition(shipMachine, saved)[0]);
    yield* Effect.gen(function* cycle() {
      const next = yield* shipCycle(yield* Ref.get(state), ports);
      yield* Ref.set(state, next);
      yield* Console.log(
        JSON.stringify({ sha: next.context.sha, state: next.value })
      );
    }).pipe(Effect.repeat(Schedule.spaced(`${intervalSeconds} seconds`)));
  });
