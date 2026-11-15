import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Exit, Fiber, Schema } from "effect";
import { expect } from "vitest";

import { backupRecoveryScript } from "../../../stacks/nest/backup-recovery.ts";
import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { backupUnit } from "../../../stacks/nest/backup-units.ts";
import { runBackup } from "../../../stacks/nest/backup.ts";
import { localExec } from "../src/local-exec.ts";
import { validateUnit } from "../src/systemd.ts";
import { advanceClock } from "./backup-clock.ts";

const backupRoot = "/mnt/example";

const staging = "/srv/example/.mailbox-backup-0123456789abcdef0123456789abcdef";

const name = "20000102T030405.123456Z-0123456789abcdef0123456789abcdef";

const bounded = new Set([
  "preflight",
  "stage",
  "snapshot",
  "cgroup",
  "pack",
  "gzip local",
  "share-open",
  "share-copy",
  "share-manifest",
  "share-commit",
  "share-verify",
  "gzip share",
  "cleanup",
  "retention",
]);

const outputs = new Map([
  ["cleanup", "BACKUP_CLEANED"],
  ["pack", "4096"],
  [
    "snapshot",
    'BACKUP_SNAPSHOT_CAPTURED {"celld":{"bytes":2048},"seaweedfs":{"bytes":2048}}',
  ],
  ["share-commit", name],
  ["share-open", `.mailbox-publish-${name}`],
  ["stage", staging],
]);

interface Model {
  readonly units: {
    node: boolean;
    store: boolean;
    grow: boolean;
    retention: boolean;
  };
  armed: boolean;
  disarmedAt: number;
}

const unitName = (unit: string | undefined) => {
  const names = new Map([
    ["rat-king-celld.service", "node"],
    ["rat-king-storage-grow.timer", "grow"],
    ["rat-king-storage-retention.timer", "retention"],
  ]);

  return names.get(unit ?? "") ?? "store";
};

const unitKey = (unit: string | undefined) =>
  unit === "node" || unit === "grow" || unit === "retention" ? unit : "store";

const labelOf = (argv: readonly string[]) => {
  if (argv[0] === "systemctl") {
    return `${argv[2]} ${unitName(argv[3])}`;
  }

  if (argv[0] === "nice" && argv[4] === "-c3" && argv[5] === "gzip") {
    return argv[7]?.startsWith(backupRoot) === true
      ? "gzip share"
      : "gzip local";
  }

  return (argv[2] === backupScript ? argv[3] : undefined) ?? "unknown";
};

const publication = (label: string) =>
  label.startsWith("share-") ||
  label.startsWith("gzip") ||
  ["pack", "cleanup", "retention"].includes(label);

const violationsOf = (model: Model, label: string) => {
  const [verb, unit] = label.split(" ");
  const { node, store, grow, retention } = model.units;

  return [
    label === "snapshot" && (node || store) && "copied while a unit ran",
    ["snapshot", "stop node"].includes(label) &&
      [grow, retention].some(Boolean) &&
      "maintenance timers ran in the stopped window",
    publication(label) &&
      (!node || !store || model.armed) &&
      `${label} ran in the stopped window`,
    verb === "stop" && model.disarmedAt !== -1 && "stopped after the window",
    verb === "stop" && unit === "store" && node && "store stopped first",
    verb === "start" && unit === "node" && !store && "node started first",
  ].filter((violation): violation is string => violation !== false);
};

const apply = (model: Model, label: string, index: number) => {
  const [verb, unit] = label.split(" ");

  if (verb === "stop" || verb === "start") {
    model.units[unitKey(unit)] = verb === "start";
  }

  if (label === "arm" || label === "disarm") {
    model.armed = label === "arm";
    model.disarmedAt = label === "arm" ? model.disarmedAt : index;
  }

  if (verb === "is-active") {
    return model.units[unitKey(unit)] ? 0 : 3;
  }

  return 0;
};

it.effect.prop(
  "the stopped window copies only with both units down, any fault or hang there restarts store then node, and publication never touches a unit",
  {
    at: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 0 }))
    ),
    hang: Arbitrary.schema(Schema.Boolean),
  },
  ({ at, hang }) =>
    Effect.gen(function* faultModel() {
      const model: Model = {
        armed: false,
        disarmedAt: -1,
        units: { grow: true, node: true, retention: true, store: true },
      };

      const calls: string[] = [];
      const violations: string[] = [];
      let faulted = -1;

      const shell = {
        exec: Effect.fn("BackupModel.exec")(function* exec(
          argv: readonly string[]
        ) {
          const label = labelOf(argv);
          const index = calls.push(label) - 1;

          if (index === at) {
            faulted = index;

            if (hang && bounded.has(label)) {
              return yield* Effect.never;
            }

            return { code: 1, stdout: "injected failure" };
          }

          violations.push(...violationsOf(model, label));

          return {
            code: apply(model, label, index),
            stdout: outputs.get(label) ?? "",
          };
        }),
      };

      const fiber = yield* Effect.forkChild(
        runBackup(shell, {
          backupRoot,
          commit: "invented-commit",
          dataRoot: "/srv/example",
          home: "/home/example",
          version: "invented-version",
        })
      );

      yield* Effect.forkChild(advanceClock);

      const exit = yield* Fiber.await(fiber);

      expect(violations).toEqual([]);
      expect(model.units).toEqual({
        grow: true,
        node: true,
        retention: true,
        store: true,
      });
      expect(model.armed).toBe(false);

      const clean =
        faulted === -1 ||
        ["cgroup", "retention"].includes(calls[faulted] ?? "");

      expect(Exit.isSuccess(exit)).toBe(clean);

      if (clean) {
        expect(calls.filter((call) => call === "start node")).toHaveLength(1);
        expect(calls.indexOf("cleanup")).toBeGreaterThan(
          calls.indexOf("gzip share")
        );
      }

      if (calls.includes("cleanup")) {
        expect(calls.indexOf("share-verify")).toBeLessThan(
          calls.indexOf("cleanup")
        );
        expect(calls.indexOf("gzip share")).toBeLessThan(
          calls.indexOf("cleanup")
        );
      }

      if (faulted > model.disarmedAt && model.disarmedAt !== -1) {
        expect(
          calls.slice(faulted).filter((call) => call.startsWith("start"))
        ).toEqual([]);
      }
    })
);

const recoveryFixture = String.raw`
import pathlib, subprocess, sys, tempfile
script, marked = sys.argv[1], sys.argv[2] == 'true'
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    marker = root / '.mailbox-backup-restart-required'
    if marked: marker.write_text('restart required')
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert marker.exists(), 'Marker removed before successful start'
        return subprocess.CompletedProcess(argv, 0)
    subprocess.run = command
    sys.argv = ['recovery', str(root)]
    exec(script, {})
    expected = [['systemctl','--user','start',unit] for unit in ['rat-king-seaweedfs.service', 'rat-king-celld.service', 'rat-king-storage-grow.timer', 'rat-king-storage-retention.timer']]
    assert calls == (expected if marked else [])
    assert not marker.exists()
    if marked:
        marker.write_text('restart required')
        calls.clear()
        def refused(argv, **kwargs):
            calls.append(argv)
            raise subprocess.CalledProcessError(1, argv)
        subprocess.run = refused
        try: exec(script, {})
        except subprocess.CalledProcessError: pass
        else: raise AssertionError('Failed start was swallowed')
        assert marker.exists(), 'Failed gate lost recovery marker'
        assert calls == [expected[0], *expected[2:]], 'Mailbox failure skipped timer recovery'
    print('RECOVERY_PASSED')
`;

it.effect.prop(
  "systemd recovery is independent of worker exit and only starts an armed mailbox, store first",
  { marked: Arbitrary.schema(Schema.Boolean) },
  ({ marked }) =>
    Effect.gen(function* independentRecovery() {
      const unit = backupUnit({
        backupRoot,
        commit: "invented",
        dataRoot: "/srv/example",
        home: "/home/example",
        ready: "ready",
        version: "invented",
      });

      yield* validateUnit(unit);

      const lines = unit.sections.flatMap((section) => section.lines);
      expect(lines).toContainEqual(["MemoryHigh", "3G"]);
      expect(lines).toContainEqual(["MemoryMax", "4G"]);
      expect(lines).toContainEqual(["CPUQuota", "200%"]);
      expect(lines).toContainEqual(["TimeoutStartSec", "4h"]);
      expect(lines).toContainEqual(["TimeoutStopSec", "90s"]);
      expect(lines).toContainEqual(["OOMPolicy", "stop"]);
      expect(lines.find(([key]) => key === "ExecStopPost")?.[1]).toContain(
        "/usr/bin/python3 -c"
      );
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        recoveryFixture,
        backupRecoveryScript,
        String(marked),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("RECOVERY_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
