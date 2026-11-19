import { Config, Effect } from "effect";
import { createActor, createMachine } from "xstate";
import type { ActorOptions, AnyActorLogic } from "xstate";

const EXIT_ENV = "RATKING_EXIT_WHEN_DRAINED";

export const drainSetting = Config.String(EXIT_ENV).pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim()),
  Effect.orElseSucceed(() => "invalid")
);

export const drainWindow = (
  value: string,
  warn: (message: string) => void
): number | null => {
  if (value === "") {
    return null;
  }

  const millis = Math.ceil(Number(value) * 60_000);

  if (!(millis > 0 && millis <= 2_147_483_647)) {
    warn(
      `${EXIT_ENV} must be a positive number of minutes within the timer range; automatic exit is off.`
    );

    return null;
  }

  return millis;
};

export type DrainClock = ActorOptions<AnyActorLogic>["clock"];

export const watchDrain = (
  millis: number,
  ready: () => boolean,
  exit: () => void,
  clock: DrainClock
) => {
  const machine = createMachine({
    initial: "blocked",
    states: {
      blocked: {
        on: {
          CHECK: () => (ready() ? { target: "waiting" } : {}),
          RESET: () => (ready() ? { target: "waiting" } : {}),
        },
      },
      expired: { type: "final" },
      waiting: {
        after: {
          [millis]: () => ({ target: ready() ? "expired" : "blocked" }),
        },
        on: {
          CHECK: () => (ready() ? {} : { target: "blocked" }),
          RESET: () =>
            ready()
              ? { reenter: true, target: "waiting" }
              : { target: "blocked" },
        },
      },
    },
  });

  const timer = createActor(machine, clock === undefined ? {} : { clock });

  timer.subscribe((snapshot) => {
    if (snapshot.status === "done") {
      exit();
    }
  });
  timer.start();
  timer.send({ type: "CHECK" });

  return {
    check: () => {
      timer.send({ type: "CHECK" });
    },
    reset: () => {
      timer.send({ type: "RESET" });
    },
    stop: () => timer.stop(),
  };
};
