import { Config, Effect, FileSystem, Option, Schema } from "effect";

import { HostError } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { RestartEvent, ShipAttempt } from "./ship-config.ts";

export const restartScript = String.raw`
import fcntl, json, os, pathlib, subprocess, sys, tempfile, time
settings = json.loads(sys.argv[1])
mode = sys.argv[2]
try:
    lock = pathlib.Path(settings['restart']['lock'])
    marker = pathlib.Path(settings['restart']['marker'])
    if any(p.is_symlink() for path in [lock, marker] for p in [path, *path.parents]):
        sys.exit(2)
    with open(lock, 'a') as held:
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit(75)
        for unit in settings['restart']['units']:
            state = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '--value'], capture_output=True, text=True)
            if state.returncode != 0 or state.stdout.strip() not in ['inactive', 'failed', 'active', 'activating', 'deactivating']:
                sys.exit(2)
            if state.stdout.strip() in ['active', 'activating', 'deactivating']:
                sys.exit(75)
        if mode == 'probe':
            sys.exit(0)
        marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        def mark(phase, started):
            fd, name = tempfile.mkstemp(dir=marker.parent)
            with os.fdopen(fd, 'w') as target:
                json.dump(dict(sha=settings['sha'], started=started, phase=phase), target)
                target.flush()
                os.fsync(target.fileno())
            os.replace(name, marker)
        started = time.time()
        mark('restarting', started)
        result = subprocess.run(sys.argv[3:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ended = time.time()
        mark('done', started)
        print(json.dumps(dict(code=result.returncode, durationSeconds=ended-started)), flush=True)
        sys.exit(result.returncode)
except Exception:
    sys.exit(2)
`;

const attempt = Config.option(
  Config.schema(Schema.fromJsonString(ShipAttempt), "RAT_KING_SHIP_ATTEMPT")
);

const appendEvent = Effect.fn("Ship.appendRestartEvent")(function* appendEvent(
  settings: typeof ShipAttempt.Type,
  event: typeof RestartEvent.Type
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    settings.events,
    `${yield* Schema.encodeEffect(Schema.fromJsonString(RestartEvent))(event)}\n`,
    { flag: "a", mode: 0o600 }
  );
});

const checked = Effect.fn("Ship.checkRestart")(function* checked(
  shell: Interface,
  settings: typeof ShipAttempt.Type
) {
  const result = yield* shell.exec([
    "python3",
    "-c",
    restartScript,
    JSON.stringify(settings),
    "probe",
  ]);

  if (result.code === 75) {
    yield* appendEvent(settings, {
      durationSeconds: 0,
      phase: "deferred",
      restarted: false,
    });

    return yield* new HostError({
      operation: "ship",
      reason: "Restart deferred while maintenance is busy",
    });
  }

  if (result.code !== 0) {
    return yield* new HostError({
      operation: "ship",
      reason: "Restart guard could not establish maintenance state",
    });
  }

  return yield* Effect.void;
});

export const guardRestartPlan = Effect.fn("Ship.guardRestartPlan")(
  function* guardRestartPlan(shell: Interface, restarting: boolean) {
    const settings = yield* attempt;

    if (restarting && Option.isSome(settings)) {
      return yield* checked(shell, settings.value);
    }

    return yield* Effect.void;
  }
);

const RestartResult = Schema.Struct({
  code: Schema.Int,
  durationSeconds: Schema.Number,
});

export const guardedShell = Effect.fn("Ship.guardedShell")(
  function* guardedShell(shell: Interface) {
    const settings = yield* attempt;

    if (Option.isNone(settings)) {
      return shell;
    }

    const target = settings.value;
    const fs = yield* FileSystem.FileSystem;

    return {
      ...shell,
      exec: Effect.fn("Ship.remoteCommand")(
        function* remoteCommand(argv, diagnostics) {
          if (
            argv[0] !== "systemctl" ||
            !argv.includes(target.restart.unit) ||
            !argv.some((arg) => ["restart", "start"].includes(arg))
          ) {
            return yield* shell.exec(argv, diagnostics);
          }

          yield* checked(shell, target);
          yield* appendEvent(target, {
            durationSeconds: 0,
            phase: "requested",
            restarted: null,
          });

          const result = yield* shell.exec([
            "python3",
            "-c",
            restartScript,
            JSON.stringify(target),
            "restart",
            ...argv,
          ]);

          if (result.code === 75) {
            yield* appendEvent(target, {
              durationSeconds: 0,
              phase: "deferred",
              restarted: false,
            });

            return yield* new HostError({
              operation: "ship",
              reason: "Restart deferred while maintenance is busy",
            });
          }

          const observed = yield* Schema.decodeEffect(
            Schema.fromJsonString(RestartResult)
          )(result.stdout).pipe(
            Effect.mapError(
              () =>
                new HostError({
                  operation: "ship",
                  reason: "Restart outcome unavailable",
                })
            )
          );

          yield* appendEvent(target, {
            durationSeconds: observed.durationSeconds,
            phase: "completed",
            restarted: observed.code === 0 ? true : null,
          });

          return { code: observed.code, stdout: "" };
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.mapError(
              () =>
                new HostError({
                  operation: "ship",
                  reason: "Guarded restart failed",
                })
            )
          )
      ),
    } satisfies Interface;
  }
);
