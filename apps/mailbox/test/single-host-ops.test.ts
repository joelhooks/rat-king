import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Console, Effect, FileSystem, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  commsCounts,
  digest,
  doneBarCommand,
} from "../../../stacks/nest/digest.ts";
import { Digest } from "../../../stacks/nest/health.ts";
import { opsDigest } from "../../../stacks/nest/ops-read.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";

const handle = (output: string, code: number) => {
  const stdout = Stream.succeed(new TextEncoder().encode(output));

  return ChildProcessSpawner.makeHandle({
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(1),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void),
  });
};

it.effect.prop(
  "single-host digest, ops-digest and done-bar run without an SSH probe",
  [StageConfig, Digest],
  ([base, facts]) =>
    Effect.gen(function* singleHost() {
      const fs = yield* FileSystem.FileSystem;

      yield* TestClock.setTime(1_800_000_000_000);
      const directory = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];
      const lines: unknown[] = [];
      const console = yield* Console.Console;
      const overrides = {};
      const counts = { fallbacks: 0, lost: 0, quarantined: 0, sent: 1 };

      const frame = JSON.stringify({
        kind: "receipt",
        line: '{"at":"2027-01-15T09:00:00.000Z"}',
      });

      const health = { ...facts, reasons: [], status: "ok" as const };

      const config = {
        ...base,
        comms: { local: base.comms.local },
        doctor: { primary: {} },
        runtime: { ...base.runtime, RAT_KING_STATE_DIR: directory },
      };

      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("unexpected pipeline");
        }

        calls.push(command.command);

        return Effect.succeed(
          command.command === "python3"
            ? handle(frame, 0)
            : handle('{"status":"ok","reasons":[]}', 0)
        );
      });

      const result = yield* Effect.gen(function* commands() {
        const observed = yield* commsCounts(config, 1_800_000_000_000);
        const fleet = yield* digest(config, () => Effect.succeed(health));
        yield* opsDigest(config, Effect.succeed(health));
        yield* doneBarCommand(config);

        return { fleet, observed };
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          Console.Console,
          Object.assign(overrides, console, {
            log: (...args: readonly unknown[]) => {
              lines.push(args.join(" "));
            },
          })
        )
      );

      expect(result.observed).toEqual({ primary: counts, secondary: null });
      expect(calls).toEqual([
        "python3",
        "python3",
        "node",
        "python3",
        "python3",
      ]);
      expect(result.fleet).toContain('"sent_24h":1');
      expect(lines).toEqual([
        expect.stringContaining('"sent_24h":1'),
        JSON.stringify({ local: counts, passed: true, remote: null }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 } }
);
