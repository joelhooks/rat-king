import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { FleetError } from "./stage-config.ts";

export const withShipLock = Effect.fn("Ship.lock")(function* withShipLock(
  state: string,
  entry: string,
  config: string,
  args: readonly string[],
  cwd: string = process.cwd()
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const lock = path.join(state, "ship.lock");

  yield* fs
    .writeFile(lock, new Uint8Array(), { flag: "wx", mode: 0o600 })
    .pipe(Effect.ignore);
  const stat = yield* fs.lstat(lock);

  if (
    stat.type !== "File" ||
    Option.getOrUndefined(stat.uid) !== process.getuid?.()
  ) {
    return yield* new FleetError({
      reason: "Ship checkpoint lock is not an owned regular file",
    });
  }

  const mac = process.platform === "darwin";
  const executable = mac ? "/usr/bin/lockf" : "/usr/bin/flock";

  const flags = mac
    ? ["-k", "-t", "0"]
    : ["--nonblock", "--no-fork", "--conflict-exit-code", "75", "--"];

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  if (!mac) {
    const capable = yield* spawner
      .exitCode(
        ChildProcess.make(executable, ["--no-fork", "--version"], {
          stderr: "ignore",
          stdout: "ignore",
        })
      )
      .pipe(Effect.option);

    if (!Option.isSome(capable) || Number(capable.value) !== 0) {
      return yield* new FleetError({
        reason: "ShipLockUnsupported: flock must support --no-fork",
      });
    }
  }

  const handle = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      [...flags, lock, process.execPath, ...process.execArgv, entry, ...args],
      {
        cwd,
        env: { RAT_KING_STAGE_CONFIG: config },
        extendEnv: true,
        stderr: "inherit",
        stdin: "pipe",
        stdout: "inherit",
      }
    )
  );

  const code = Number(yield* handle.exitCode);

  if (code !== 0) {
    return yield* new FleetError({
      reason: code === 75 ? "ShipLockContended" : "ShipWorkerFailed",
    });
  }

  return yield* Effect.void;
}, Effect.scoped);
