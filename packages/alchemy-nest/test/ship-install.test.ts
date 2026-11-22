import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { initialTransition } from "xstate";

import type { ShipReceipt } from "../../../stacks/nest/ship-config.ts";
import {
  installDependencies,
  quarantineInstall,
} from "../../../stacks/nest/ship-install.ts";
import { shipMachine } from "../../../stacks/nest/ship-machine.ts";
import { shipCycle } from "../../../stacks/nest/ship.ts";
import { FleetError } from "../../../stacks/nest/stage-config.ts";

const sha = "a".repeat(40);

const progress = (added: number) =>
  `Progress: resolved 439, reused 439, downloaded 0, added ${added}`;

const startedLine = "private token=fixture-private\n";

const processHandle = (exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>) =>
  ChildProcessSpawner.makeHandle({
    all: Stream.empty,
    exitCode,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    pid: ChildProcessSpawner.ProcessId(1),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout: Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

it.effect.prop(
  "ship reports sanitized attempt facts and a timeout resets the scoped checkout before the online attempt",
  {
    added: Schema.Int.check(Schema.isBetween({ maximum: 438, minimum: 1 })),
    timedOut: Schema.Boolean,
  },
  ({ added, timedOut }) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const release = `${directory}/${sha}`;
      const marker = `${release}/partial-install`;
      const log = `${release}.install.log`;
      const started = yield* Deferred.make<boolean>();
      const attempts: string[] = [];
      const receipts: (typeof ShipReceipt.Type)[] = [];
      let exited = false;
      yield* fs.makeDirectory(release);
      yield* fs.writeFileString(log, `${progress(999)}\n`);

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* spawn() {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("unexpected pipeline");
          }

          expect(command.options.cwd).toBe(release);
          expect(command.options.forceKillAfter).toBe("5 seconds");
          expect(command.args).toContain("--reporter=append-only");

          if (command.args.includes("--offline")) {
            attempts.push("offline");
            yield* fs.writeFileString(marker, "partial");
            yield* fs.writeFileString(
              log,
              `${progress(added)}\n${startedLine}`,
              { flag: "a" }
            );

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                exited = true;
              })
            );
            yield* Deferred.succeed(started, true);

            return processHandle(
              timedOut
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(17))
            );
          }

          attempts.push("online");
          expect(exited).toBe(true);
          expect(yield* fs.exists(marker)).toBe(!timedOut);
          yield* fs.writeFileString(
            log,
            `ERR_PNPM_FETCH_404 https://private.invalid\n${startedLine}`,
            { flag: "a" }
          );

          return processHandle(
            Effect.succeed(ChildProcessSpawner.ExitCode(23))
          );
        }).pipe(Effect.orDie)
      );

      const reset = quarantineInstall(directory, sha).pipe(
        Effect.andThen(fs.makeDirectory(release)),
        Effect.mapError(
          () => new FleetError({ reason: "unable to reset fixture" })
        )
      );

      const [initial] = initialTransition(shipMachine, {
        failed: "",
        successful: "",
      });

      const cycle = yield* shipCycle(initial, {
        checkpoint: () => Effect.void,
        ci: () => Effect.succeed(true),
        deploy: () =>
          installDependencies({ pnpm: "pnpm", release, reset }).pipe(
            Effect.as({
              celldRestarted: false,
              restartSeconds: null,
              result: "success" as const,
            })
          ),
        fetch: Effect.succeed(sha),
        notify: () => Effect.void,
        record: (receipt) =>
          Effect.sync(() => {
            receipts.push(receipt);
          }),
        recover: Effect.succeed("running"),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild
      );

      yield* Deferred.await(started);

      if (timedOut) {
        yield* TestClock.adjust("8 minutes");
      }

      yield* Fiber.join(cycle);
      expect(attempts).toEqual(["offline", "online"]);
      expect(receipts).toHaveLength(1);

      const [receipt] = receipts;

      expect(receipt).toMatchObject({
        celldRestarted: null,
        result: "failed",
        sha,
      });
      expect(receipt?.stderrTail).toContain(
        timedOut
          ? `offline install timed out after 8 min at ${progress(added)}`
          : `offline install exited 17 at ${progress(added)}`
      );
      expect(receipt?.stderrTail).toContain(
        "online install exited 23 at no progress line; log tail: ERR_PNPM_FETCH_404"
      );
      expect(receipt?.stderrTail).not.toMatch(
        /fixture-private|private\.invalid|999/u
      );

      const entries = yield* fs.readDirectory(directory);

      expect(
        entries.filter((entry) => entry.startsWith(".trash-"))
      ).toHaveLength(timedOut ? 1 : 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);
