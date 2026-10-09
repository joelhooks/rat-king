import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupRecoveryScript } from "../../../stacks/nest/backup-recovery.ts";
import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { backupUnit } from "../../../stacks/nest/backup-units.ts";
import { runBackup } from "../../../stacks/nest/backup.ts";
import { localExec } from "../src/local-exec.ts";
import { s3Script } from "../src/s3-script.ts";
import { validateUnit } from "../src/systemd.ts";

it.effect.prop(
  "every command failure after arming attempts guarded restart, with bulk copy before stop",
  {
    failure: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 }))
    ),
  },
  ({ failure }) =>
    Effect.gen(function* failureRecovery() {
      const calls: string[] = [];
      let armed = false;
      let afterArm = 0;

      const shell = {
        exec: Effect.fn("BackupTest.exec")(function* exec(
          argv: readonly string[]
        ) {
          yield* Effect.void;

          let action = argv.at(2);

          if (action === backupScript) {
            action = argv.at(3);
          } else if (action === s3Script) {
            action = argv.at(6);
          }

          calls.push(action ?? "unknown");

          if (armed) {
            const current = afterArm;

            afterArm += 1;

            if (current === failure) {
              return { code: 1, stdout: "injected failure" };
            }
          }

          if (action === "arm") {
            armed = true;
          }

          return {
            code: 0,
            stdout:
              action === "stage"
                ? "/srv/example/.mailbox-backup-0123456789abcdef0123456789abcdef"
                : "",
          };
        }),
      };

      yield* Effect.exit(
        runBackup(shell, {
          backupRoot: "/mnt/example",
          commit: "invented-commit",
          dataRoot: "/srv/example",
          home: "/home/example",
          version: "invented-version",
        })
      );
      expect(calls.indexOf("prepare")).toBeLessThan(calls.indexOf("stop"));
      expect(calls.slice(calls.indexOf("arm") + 1)).toContain("start");

      if (calls.includes("pack")) {
        expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("pack"));
      }

      if (calls.includes("publish")) {
        expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("publish"));
        expect(calls.indexOf("disarm")).toBeLessThan(calls.indexOf("publish"));
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
    # This is the same independent hook regardless of exit reason: error,
    # timeout/SIGTERM, OOM or SIGKILL cannot run the Node recovery handler.
    exec(script, {})
    assert calls == ([['systemctl','--user','start','rat-king-celld.service']] if marked else [])
    assert not marker.exists()
    if marked:
        marker.write_text('restart required')
        def refused(argv, **kwargs): raise subprocess.CalledProcessError(1, argv)
        subprocess.run = refused
        try: exec(script, {})
        except subprocess.CalledProcessError: pass
        else: raise AssertionError('Failed start was swallowed')
        assert marker.exists(), 'Failed gate lost recovery marker'
    print('RECOVERY_PASSED')
`;

it.effect.prop(
  "systemd recovery is independent of worker exit and only starts an armed mailbox",
  { marked: Arbitrary.schema(Schema.Boolean) },
  ({ marked }) =>
    Effect.gen(function* independentRecovery() {
      const unit = backupUnit({
        backupRoot: "/mnt/example",
        commit: "invented",
        dataRoot: "/srv/example",
        home: "/home/example",
        ready: "ready",
        version: "invented",
      });

      yield* validateUnit(unit);

      const lines = unit.sections.flatMap((section) => section.lines);
      expect(lines).toContainEqual(["MemoryHigh", "128M"]);
      expect(lines).toContainEqual(["MemoryMax", "256M"]);
      expect(lines).toContainEqual(["TimeoutStartSec", "30min"]);
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
