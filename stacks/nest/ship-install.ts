import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Random,
  Result,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Sha } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";

const budget = "8 minutes";

const logBytes = 16_384;

const progress =
  /^Progress: resolved \d+, reused \d+, downloaded \d+, added \d+(?:, done)?$/u;

const logFact = /^(?:Packages: [+-]\d+|ERR_PNPM_[A-Z0-9_]{1,80})(?=\s|$)/u;

const logLines = (text: string) =>
  text.split(/[\r\n]+/u).flatMap((raw) => {
    const line = raw.trim();
    const fact = progress.test(line) ? line : logFact.exec(line)?.[0];

    return fact === undefined ? [] : [fact];
  });

const readTail = Effect.fn("Ship.installLogTail")(
  function* readTail(log: string, offset: bigint) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(log, { flag: "r" });
    const { size } = yield* file.stat;

    const position =
      size - offset > logBytes ? size - BigInt(logBytes) : offset;

    const bytes = yield* file.readAlloc(logBytes, { position });

    return Option.match(bytes, {
      onNone: () => [],
      onSome: (value) => logLines(new TextDecoder().decode(value)),
    });
  },
  Effect.scoped,
  Effect.orElseSucceed((): string[] => [])
);

const logOffset = Effect.fn("Ship.installLogOffset")(function* logOffset(
  log: string
) {
  const fs = yield* FileSystem.FileSystem;

  const file = yield* fs.lstat(log).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)
  );

  if (Option.isNone(file)) {
    yield* fs.writeFileString(log, "", { flag: "wx", mode: 0o600 });

    return 0n;
  }

  if (file.value.type !== "File") {
    return yield* new FleetError({
      reason: "pnpm install log is not a regular file",
    });
  }

  yield* fs.chmod(log, 0o600);

  return file.value.size;
});

const runInstall = Effect.fn("Ship.runInstall")(function* runInstall(
  pnpm: string,
  cwd: string,
  log: string,
  offline: boolean
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "/bin/sh",
      [
        "-c",
        'log="$1"; shift; exec "$@" >>"$log" 2>&1',
        "sh",
        log,
        pnpm,
        "install",
        "--frozen-lockfile",
        "--reporter=append-only",
        ...(offline ? ["--offline"] : []),
      ],
      {
        cwd,
        forceKillAfter: "5 seconds",
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      }
    )
  );

  return Number(yield* handle.exitCode);
}, Effect.scoped);

const installAttempt = Effect.fn("Ship.installAttempt")(
  function* installAttempt(
    pnpm: string,
    cwd: string,
    log: string,
    mode: "offline" | "online"
  ) {
    const offset = yield* logOffset(log).pipe(
      Effect.mapError(
        (error) =>
          new FleetError({
            reason: `${mode} install log unavailable: ${Schema.is(FleetError)(error) ? error.reason : error.reason._tag}`,
          })
      )
    );

    const result = yield* runInstall(pnpm, cwd, log, mode === "offline").pipe(
      Effect.timeout(budget),
      Effect.result
    );

    if (Result.isSuccess(result) && result.success === 0) {
      return null;
    }

    const lines = yield* readTail(log, offset);

    const last =
      lines.findLast((line) => progress.test(line)) ?? "no progress line";

    const tail = lines.slice(-4).join("; ");
    const detail = tail === "" ? "" : `; log tail: ${tail}`;

    if (Result.isSuccess(result)) {
      return {
        reason: `${mode} install exited ${result.success} at ${last}${detail}`,
        timedOut: false,
      };
    }

    const { failure } = result;

    return Predicate.isTagged(failure, "TimeoutError")
      ? {
          reason: `${mode} install timed out after 8 min at ${last}${detail}`,
          timedOut: true,
        }
      : {
          reason: `${mode} install process failed (${failure.reason._tag}) at ${last}${detail}`,
          timedOut: false,
        };
  }
);

export const quarantineInstall = Effect.fn("Ship.quarantineInstall")(
  function* quarantineInstall(releases: string, sha: string) {
    const fs = yield* FileSystem.FileSystem;
    const release = `${releases}/${sha}`;

    if (
      !Schema.is(Sha)(sha) ||
      (yield* fs.lstat(release)).type !== "Directory"
    ) {
      return yield* new FleetError({
        reason: "Refusing to move an unowned release path",
      });
    }

    const epoch = yield* Clock.currentTimeMillis;
    const nonce = yield* Random.nextIntBetween(0, 2_147_483_647);

    return yield* fs.rename(
      release,
      `${releases}/.trash-${epoch}-${nonce.toString(36)}`
    );
  }
);

export const installDependencies = Effect.fn("Ship.installDependencies")(
  function* installDependencies<R>(input: {
    readonly pnpm: string;
    readonly release: string;
    readonly reset: Effect.Effect<void, FleetError, R>;
  }) {
    const { pnpm, release, reset } = input;
    const log = `${release}.install.log`;
    const offline = yield* installAttempt(pnpm, release, log, "offline");

    if (offline === null) {
      return yield* Effect.void;
    }

    if (offline.timedOut) {
      yield* reset.pipe(
        Effect.mapError(
          (error) =>
            new FleetError({
              reason: `${offline.reason}; clean retry unavailable: ${error.reason}`,
            })
        )
      );
    }

    const online = yield* installAttempt(pnpm, release, log, "online");

    if (online !== null) {
      return yield* new FleetError({
        reason: `${offline.reason}; ${online.reason}`,
      });
    }

    return yield* Effect.void;
  }
);
