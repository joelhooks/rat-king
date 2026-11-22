import { Clock, Console, Effect, Option, Ref } from "effect";
import type { SnapshotFrom } from "xstate";
import { initialTransition, transition } from "xstate";

import type { PreparedFleetPayload } from "./prepared-payload.ts";
import type { ShipCheckpoint, ShipReceipt } from "./ship-config.ts";
import { redactStderrExcerpt } from "./ship-diagnostics.ts";
import { shipMachine } from "./ship-machine.ts";
import type { ShipEvent } from "./ship-machine.ts";
import type { PreparedSelection } from "./ship-select.ts";
import { FleetError } from "./stage-config.ts";

export type ShipSnapshot = SnapshotFrom<typeof shipMachine>;

export interface ShipPorts<R = never> {
  readonly fetch: Effect.Effect<string, FleetError, R>;
  readonly ci: (sha: string) => Effect.Effect<boolean, FleetError, R>;
  readonly deploy: (
    sha: string
  ) => Effect.Effect<
    Pick<
      typeof ShipReceipt.Type,
      | "celldRestarted"
      | "restartSeconds"
      | "retryAt"
      | "stderrTail"
      | "override"
    > & { readonly result: "success" | "failed" | "deferred" },
    FleetError,
    R
  >;
  readonly checkpoint: (
    snapshot: Pick<ShipSnapshot["context"], "failed" | "successful"> &
      Partial<
        Pick<
          ShipSnapshot["context"],
          "deferred" | "failedGate" | "preparedRetries" | "retryAt"
        >
      >
  ) => Effect.Effect<void, FleetError, R>;
  readonly recover: Effect.Effect<
    "running" | "recovered" | "failed",
    FleetError,
    R
  >;
  readonly record: (
    receipt: typeof ShipReceipt.Type
  ) => Effect.Effect<void, FleetError, R>;
  readonly notify: (
    receipt: typeof ShipReceipt.Type
  ) => Effect.Effect<void, FleetError, R>;
}

export interface PreparedShipPorts<R = never> extends Omit<
  ShipPorts<R>,
  "ci" | "deploy" | "fetch"
> {
  readonly select: (
    saved: typeof ShipCheckpoint.Type,
    now: number
  ) => Effect.Effect<Option.Option<PreparedSelection>, never, R>;
  readonly deployPrepared: (
    payload: PreparedFleetPayload
  ) => ReturnType<ShipPorts<R>["deploy"]>;
}

type CyclePorts<R> = ShipPorts<R> | PreparedShipPorts<R>;

const advance = (snapshot: ShipSnapshot, event: ShipEvent) =>
  transition(shipMachine, snapshot, event)[0];

const preparedStateRefused = () =>
  new FleetError({
    reason: "PreparedStateMismatch: machine did not accept the selected SHA",
  });

const acquire = Effect.fn("Ship.acquire")(function* acquire<R>(
  snapshot: ShipSnapshot,
  ports: CyclePorts<R>,
  tickedAt: number
) {
  let current = advance(snapshot, { now: tickedAt, type: "tick" });

  if (current.matches("fetch-error")) {
    return { current };
  }

  if ("select" in ports) {
    if (!current.matches("fetching")) {
      return yield* preparedStateRefused();
    }

    const selected = yield* ports.select(current.context, tickedAt);

    if (Option.isNone(selected)) {
      return { current: advance(current, { type: "notReady" }) };
    }

    const { ahead, payload } = selected.value;
    current = advance(current, {
      ahead,
      sha: payload.commit,
      type: "prepared",
    });

    if (
      !current.matches("waiting-ci") ||
      current.context.sha !== payload.commit ||
      !ahead.includes(payload.commit) ||
      payload.commit === current.context.successful ||
      payload.commit === current.context.failed
    ) {
      return yield* preparedStateRefused();
    }

    return {
      current,
      deploy: Effect.suspend(() => ports.deployPrepared(payload)),
      prepared: payload.commit,
    };
  }

  const fetched = yield* ports.fetch.pipe(Effect.option);

  if (Option.isNone(fetched)) {
    if (!snapshot.matches("fetch-error")) {
      yield* Console.error("SHIP_FETCH_FAILED");
    }

    return {
      current: advance(current, { now: tickedAt, type: "fetchFailed" }),
    };
  }

  current = advance(current, {
    now: (yield* Clock.currentTimeMillis) / 1000,
    sha: fetched.value,
    type: "observed",
  });

  if (!current.matches("waiting-ci")) {
    return { current };
  }

  if (
    !(yield* ports
      .ci(current.context.sha)
      .pipe(Effect.orElseSucceed(() => false)))
  ) {
    return { current: advance(current, { type: "pending" }) };
  }

  return { current, deploy: ports.deploy(current.context.sha) };
});

const recordInterruption = Effect.fn("Ship.recordInterruption")(
  function* recordInterruption<R>(
    ports: CyclePorts<R>,
    snapshot: ShipSnapshot,
    sha: string,
    start: number
  ) {
    const end = (yield* Clock.currentTimeMillis) / 1000;

    const retryAt = end + 120;

    yield* ports.checkpoint({
      ...snapshot.context,
      preparedRetries: { ...snapshot.context.preparedRetries, [sha]: retryAt },
    });

    const receipt = {
      celldRestarted: null,
      end,
      restartSeconds: null,
      result: "interrupted" as const,
      retryAt,
      sha,
      start,
    };

    yield* ports.record(receipt);

    const recovery = yield* ports.recover.pipe(
      Effect.interruptible,
      Effect.timeout("30 seconds"),
      Effect.orElseSucceed(() => "failed" as const)
    );

    if (recovery === "failed") {
      yield* Console.error("SHIP_INTERRUPTION_RECOVERY_FAILED", sha);
    }
  },
  (effect) =>
    effect.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Console.error("SHIP_INTERRUPTION_RECORD_FAILED", error.reason),
        onSuccess: () => Effect.void,
      })
    )
);

export const shipCycle = Effect.fn("Ship.cycle")(function* shipCycle<R>(
  snapshot: ShipSnapshot,
  ports: CyclePorts<R>
) {
  const acquired = yield* acquire(
    snapshot,
    ports,
    (yield* Clock.currentTimeMillis) / 1000
  );

  if (acquired.deploy === undefined) {
    return acquired.current;
  }

  let current = advance(acquired.current, { type: "ready" });
  const start = (yield* Clock.currentTimeMillis) / 1000;
  const { sha } = current.context;

  if (
    acquired.prepared !== undefined &&
    (!current.matches("deploying") || sha !== acquired.prepared)
  ) {
    return yield* preparedStateRefused();
  }

  const { deploy, prepared } = acquired;
  const armed = { failed: sha, successful: current.context.successful };

  const arm = ports.checkpoint(
    Object.keys(current.context.preparedRetries).length === 0
      ? armed
      : { ...armed, preparedRetries: current.context.preparedRetries }
  );

  const deployed = yield* Effect.uninterruptibleMask((restore) =>
    arm.pipe(
      Effect.andThen(
        restore(deploy).pipe(
          Effect.onInterrupt(() =>
            prepared === undefined
              ? Effect.void
              : recordInterruption(ports, snapshot, prepared, start)
          ),
          Effect.catch((error) =>
            Effect.succeed({
              celldRestarted: null,
              restartSeconds: null,
              result: "failed" as const,
              stderrTail: redactStderrExcerpt(error.reason),
            })
          )
        )
      )
    )
  );

  const recovery =
    deployed.result === "failed"
      ? yield* ports.recover.pipe(Effect.orElseSucceed(() => "failed" as const))
      : "running";

  const finished = {
    ...deployed,
    end: (yield* Clock.currentTimeMillis) / 1000,
    sha,
    start,
  };

  const gated =
    deployed.result === "failed" ? { ...finished, gate: "deploy" } : finished;

  const receipt =
    recovery === "running"
      ? gated
      : { ...gated, recovered: recovery === "recovered" };

  yield* ports.record(receipt);

  if (deployed.result === "deferred") {
    current = advance(current, {
      retryAt: deployed.retryAt ?? 0,
      type: "deferred",
    });
  } else if (deployed.result === "failed") {
    current = advance(current, { gate: "deploy", type: "failure" });
  } else {
    current = advance(current, { type: "success" });
  }

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
  ports: CyclePorts<R>,
  saved: typeof ShipCheckpoint.Type,
  intervalSeconds: number | Effect.Effect<number>,
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

      if (yield* drifted) {
        return true;
      }

      const pause = Effect.isEffect(intervalSeconds)
        ? yield* intervalSeconds
        : intervalSeconds;

      yield* Effect.sleep(`${pause} seconds`);

      return false;
    }).pipe(Effect.repeat({ until: (stale) => stale }));
    yield* Console.log(
      JSON.stringify({ runner: "code changed; exiting for launchd restart" })
    );
  });
