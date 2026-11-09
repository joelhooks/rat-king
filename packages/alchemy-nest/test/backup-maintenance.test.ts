import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Schema,
} from "effect";
import { flow } from "effect/Function";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  backupControl,
  maintenanceTimers,
  restartMaintenanceTimers,
} from "../../../stacks/nest/backup-control.ts";
import { captureCommand } from "../../../stacks/nest/backup-exec.ts";
import {
  nodeService,
  runBackup,
  storeService,
} from "../../../stacks/nest/backup.ts";
import { HostError } from "../src/host-error.ts";
import { localExec } from "../src/local-exec.ts";
import {
  storageGrowUnit,
  storageRetentionUnit,
} from "../src/storage-maintenance.ts";
import type { UnitProps } from "../src/systemd.ts";
import { renderUnit } from "../src/systemd.ts";

const grow = storageGrowUnit(
  "/home/example",
  "/opt/example/maintenance.py",
  []
);

const retention = storageRetentionUnit(
  "/home/example",
  "/opt/example/maintenance.py",
  []
);

const maintenance = [grow, retention];

interface Model {
  readonly storeActive: boolean;
}

interface Scheduler {
  readonly active: Map<string, boolean>;
  attempts: number;
}

const timerStart = (unit: UnitProps): AsyncCommand<Model, Scheduler> => ({
  check: () => true,
  run: flow(
    Effect.fn("MaintenanceModel.timerStart")(
      (model: Model, scheduler: Scheduler) =>
        Effect.sync(() => {
          const dependencies = unit.sections.flatMap(
            (section) => section.lines
          );

          if (dependencies.some(([key]) => key === "Requires")) {
            scheduler.active.set(storeService, true);
          }

          scheduler.attempts += 1;
          expect(scheduler.active.get(storeService)).toBe(model.storeActive);
          expect(dependencies).toContainEqual(["Requisite", storeService]);
          expect(dependencies).toContainEqual(["After", storeService]);
          expect(renderUnit(unit)).not.toContain("Requires=");
        })
    ),
    Effect.runPromise
  ),
  toString: () => `TimerStart(${unit.name})`,
});

const published = "20000102T030405.123456Z-0123456789abcdef0123456789abcdef";

const outputs = new Map([
  ["stage", "/srv/example/.mailbox-backup-0123456789abcdef0123456789abcdef"],
  ["pack", "4096"],
  ["share-open", `.mailbox-publish-${published}`],
  ["share-commit", published],
]);

it.effect.prop(
  "timer starts during store stop and snapshot cannot start storage, and success or failed recovery restores both timers",
  {
    events: Arbitrary.schema(
      Schema.Array(Schema.Boolean).check(Schema.isMaxLength(20))
    ),
    fault: Arbitrary.schema(
      Schema.Literals(["none", "stop-store", "snapshot", "recovery"])
    ),
  },
  ({ events, fault }) =>
    Effect.gen(function* collision() {
      const scheduler: Scheduler = {
        active: new Map(
          [nodeService, storeService, ...maintenanceTimers].map((unit) => [
            unit,
            true,
          ])
        ),
        attempts: 0,
      };

      const commands = [
        ...maintenance,
        ...events.map((isGrow) => (isGrow ? grow : retention)),
      ].map(timerStart);

      const burst = () =>
        Effect.promise(
          asyncModelRun.bind(
            undefined,
            () => ({
              model: { storeActive: false },
              real: scheduler,
            }),
            commands
          )
        );

      const calls: string[] = [];
      let failed = false;

      const shell = {
        exec: Effect.fn("MaintenanceModel.exec")(function* exec(
          argv: readonly string[]
        ) {
          const action =
            argv[0] === "systemctl"
              ? `${argv[2]} ${argv[3]}`
              : (argv[3] ?? "unknown");

          calls.push(action);

          if (action === `stop ${nodeService}` || action === "snapshot") {
            expect(
              maintenanceTimers.map((unit) => scheduler.active.get(unit))
            ).toEqual([false, false]);
          }

          if (action === `stop ${storeService}`) {
            scheduler.active.set(storeService, false);
            yield* burst();
          }

          if (action === "snapshot") {
            expect(scheduler.active.get(nodeService)).toBe(false);
            yield* burst();
          }

          if (
            (!failed &&
              fault === "stop-store" &&
              action === `stop ${storeService}`) ||
            ((fault === "snapshot" || fault === "recovery") &&
              action === "snapshot") ||
            (fault === "recovery" && action === `start ${storeService}`)
          ) {
            failed = true;

            return { code: 1, stderr: "Job canceled", stdout: "" };
          }

          if (
            argv[0] === "systemctl" &&
            argv[3] !== undefined &&
            (argv[2] === "stop" || argv[2] === "start")
          ) {
            scheduler.active.set(argv[3], argv[2] === "start");
          }

          return { code: 0, stdout: outputs.get(action) ?? "" };
        }),
      };

      const exit = yield* runBackup(
        shell,
        {
          backupRoot: "/mnt/example",
          commit: "invented",
          dataRoot: "/srv/example",
          home: "/home/example",
          version: "invented",
        },
        Duration.zero
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(fault === "none");
      expect(scheduler.attempts).toBeGreaterThanOrEqual(2);
      expect(
        maintenanceTimers.map((unit) => scheduler.active.get(unit))
      ).toEqual([true, true]);
      expect(calls.includes("share-commit")).toBe(fault === "none");
      expect(calls.includes("disarm")).toBe(fault !== "recovery");
    })
);

it.effect.prop(
  "failed unit commands identify the unit, exit status and job result without leaking command output",
  {
    code: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 1 }))
    ),
    job: Arbitrary.schema(
      Schema.Literals(["canceled", "dependency", "timeout", "failed"])
    ),
    transport: Arbitrary.schema(Schema.Boolean),
    unit: Arbitrary.schema(
      Schema.Literals([storeService, nodeService, ...maintenanceTimers])
    ),
  },
  ({ unit, code, job, transport }) => {
    const lines: string[] = [];

    const capture = Logger.layer([
      Logger.make(({ message }) => {
        lines.push((Array.isArray(message) ? message : [message]).join(" "));
      }),
    ]);

    return Effect.gen(function* diagnostics() {
      const shell = yield* localExec;

      const exit = yield* backupControl(
        {
          exec: () =>
            transport
              ? Effect.fail(
                  new HostError({
                    operation: "exec",
                    reason: "private-output",
                  })
                )
              : captureCommand(shell, [
                  "python3",
                  "-c",
                  "import sys; print('private-output'); print('Job ' + sys.argv[1] + ': private-output', file=sys.stderr); sys.exit(int(sys.argv[2]))",
                  job,
                  String(code),
                ]),
        },
        "stop",
        unit
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(lines).toEqual([
        `BACKUP_UNIT_FAILED unit=${unit} action=stop exit=${transport ? "unavailable" : code} job=${transport ? "unknown" : job}`,
      ]);
      expect(lines.join(" ")).not.toContain("private-output");
    }).pipe(Effect.provide(Layer.merge(capture, NodeServices.layer)));
  }
);

it.effect.prop(
  "timer recovery attempts both starts despite interruption or a failed first start",
  {
    fail: Arbitrary.schema(Schema.Boolean),
    interrupt: Arbitrary.schema(Schema.Boolean),
  },
  ({ fail, interrupt }) =>
    Effect.gen(function* timerRecovery() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const calls: string[] = [];

      const shell = {
        exec: Effect.fn("TimerRecovery.exec")(function* exec(
          argv: readonly string[]
        ) {
          const unit = argv[3] ?? "missing";
          calls.push(unit);

          if (unit === maintenanceTimers[0]) {
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
          }

          return {
            code: fail && unit === maintenanceTimers[0] ? 1 : 0,
            stdout: "",
          };
        }),
      };

      const fiber = yield* restartMaintenanceTimers(shell).pipe(
        Effect.forkChild
      );

      yield* Deferred.await(entered);

      if (interrupt) {
        yield* Effect.sync(() => {
          fiber.interruptUnsafe();
        });
      }

      yield* Deferred.succeed(release, true);
      const exit = yield* Fiber.await(fiber);
      expect(calls).toEqual(maintenanceTimers);
      expect(Exit.isFailure(exit)).toBe(fail || interrupt);
    })
);
