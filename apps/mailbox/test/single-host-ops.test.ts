import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Console, Effect, FileSystem, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { LaunchdAlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  commsCounts,
  digest,
  doneBarCommand,
} from "../../../stacks/nest/digest.ts";
import { Digest } from "../../../stacks/nest/health.ts";
import { opsDigest, opsMailboxHealth } from "../../../stacks/nest/ops-read.ts";
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

      const { alarm: _alarm, ...stage } = base;

      const config = {
        ...stage,
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

it.effect.prop(
  "disabled sources show as off in digest and health without fabricating quarantine counts or skipping comms receipts",
  [StageConfig, LaunchdAlarmSettings, Digest],
  ([base, alarm, facts]) =>
    Effect.gen(function* sourceOutput() {
      const fs = yield* FileSystem.FileSystem;
      const console = yield* Console.Console;
      const lines: string[] = [];
      const directory = yield* fs.makeTempDirectoryScoped();
      const receipts = `${directory}/comms.jsonl`;
      const health = { ...facts, reasons: [], status: "ok" as const };
      const { doctor: _doctor, ...stage } = base;

      const config = {
        ...stage,
        alarm: {
          ...alarm,
          sources: { doctor: false, quarantine: false, receipts: false },
        },
        comms: { local: { quarantine: `${directory}/missing`, receipts } },
        runtime: { ...base.runtime, RAT_KING_STATE_DIR: directory },
      };

      yield* TestClock.setTime(1_800_000_000_000);
      yield* fs.writeFileString(
        receipts,
        '{"at":"2027-01-15T09:00:00.000Z"}\n'
      );

      const fleet = yield* digest(config, () => Effect.succeed(health));

      const overrides = {};

      yield* Effect.all([
        opsDigest(config, Effect.succeed(health)),
        opsMailboxHealth(Effect.succeed(health), config.alarm),
      ]).pipe(
        Effect.provideService(
          Console.Console,
          Object.assign(overrides, console, {
            log: (...args: readonly unknown[]) => {
              lines.push(args.join(" "));
            },
          })
        )
      );

      const off =
        '"alarmSources":{"doctor":"off","quarantine":"off","receipts":"off"}';

      expect(fleet).toContain(off);
      expect(fleet).toContain('"quarantined_24h":null');
      expect(fleet).toContain('"sent_24h":1');
      expect(fleet).not.toContain("issuer is not configured");
      expect(lines).toEqual([
        expect.stringContaining('"quarantined_24h":null'),
        expect.stringContaining('"name":"mailbox"'),
      ]);
      expect(lines.every((line) => line.includes(off))).toBe(true);

      const required = {
        ...config,
        alarm: {
          ...config.alarm,
          sources: { ...config.alarm.sources, quarantine: true },
        },
      };

      const enabled = yield* Effect.result(
        opsDigest(required, Effect.succeed(health))
      );

      const doneBar = yield* Effect.result(doneBarCommand(config));

      expect(Result.isFailure(enabled)).toBe(true);
      expect(Result.isFailure(doneBar)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 } }
);
