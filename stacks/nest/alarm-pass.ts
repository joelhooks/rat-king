import { Clock, Console, Effect, Fiber } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { alarmStep } from "./alarm-heartbeat.ts";
import type { FleetError } from "./stage-config.ts";

export const ALARM_INTERVAL_MS = 60_000;

export const ALARM_CYCLE_DEADLINE_MS = 5 * ALARM_INTERVAL_MS;

interface DeadlineEvidence {
  readonly ms: number;
  readonly pending: string;
}

const exitOnDeadline = ({ ms, pending }: DeadlineEvidence) =>
  Effect.callback<null>((resume) => {
    try {
      process.stderr.write(
        `${JSON.stringify({ alarm: "cycle-deadline", ms, pending })}\n`,
        () => {
          resume(Effect.succeed(null));
        }
      );
    } catch {
      resume(Effect.succeed(null));
    }
  }).pipe(
    Effect.timeoutOption("250 millis"),
    Effect.andThen(Effect.sync(() => process.exit(1))),
    Effect.uninterruptible
  );

export const sendSystemdWatchdog = (socket: string) =>
  Effect.gen(function* notify() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make("/usr/bin/systemd-notify", ["WATCHDOG=1"], {
        env: { NOTIFY_SOCKET: socket },
        forceKillAfter: "250 millis",
        killSignal: "SIGKILL",
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      })
    );

    return (yield* child.exitCode) === 0;
  }).pipe(
    Effect.scoped,
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Console.error('{"alarm":"watchdog-notify-unavailable"}')
    )
  );

export const alarmCycleReporter = (
  write: (line: string) => Effect.Effect<void> = Console.info
) => {
  let last: bigint | undefined;

  return Effect.fn("Alarm.reportCycle")(function* report(started: bigint) {
    const now = yield* Clock.monotonicTimeNanos;
    const nanosPerMillis = 1_000_000n;

    if (
      last !== undefined &&
      (now - last) / nanosPerMillis < ALARM_INTERVAL_MS
    ) {
      return;
    }

    last = now;

    yield* write(
      JSON.stringify({
        alarm: "cycle",
        ms: Number((now - started) / nanosPerMillis),
      })
    );
  });
};

export const runAlarmWork = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  onFailure: (failure: FleetError) => Effect.Effect<void>
) =>
  alarmStep("cycle", work.pipe(Effect.timeout("55 seconds"))).pipe(
    Effect.matchEffect({ onFailure, onSuccess: Effect.succeed })
  );

export const runAlarmPass = <E, R, N, F = never>(
  cycle: (track: (pending: string) => void) => Effect.Effect<boolean, E, R>,
  options: {
    readonly notifySocket: string | undefined;
    readonly notify: (socket: string) => Effect.Effect<void, never, N>;
    readonly onDeadline?: (
      evidence: DeadlineEvidence
    ) => Effect.Effect<never, F>;
  }
) => {
  const { notifySocket, notify, onDeadline = exitOnDeadline } = options;

  return Effect.gen(function* supervisePass() {
    let pending = "preflight";

    const worker = yield* cycle((step) => {
      pending = step;
    }).pipe(Effect.forkChild);

    const completed = yield* Fiber.join(worker).pipe(
      Effect.timeoutOrElse({
        duration: ALARM_CYCLE_DEADLINE_MS,
        orElse: () => onDeadline({ ms: ALARM_CYCLE_DEADLINE_MS, pending }),
      })
    );

    if (completed && notifySocket !== undefined && notifySocket !== "") {
      yield* notify(notifySocket);
    }

    return completed;
  });
};
