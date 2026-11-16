import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import type { Interface } from "../src/host-shell.ts";
import { reconcileUnit, renderUnit } from "../src/systemd.ts";
import type { UnitProps } from "../src/systemd.ts";

const Scenario = Schema.Struct({
  finishes: Schema.Boolean,
  state: Schema.Literals(["active", "activating"]),
  version: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
});

const backup = (version: number): UnitProps => ({
  home: "/home/example",
  name: "example-backup.service",
  scope: "user",
  sections: [
    {
      lines: [
        ["Type", "oneshot"],
        ["ExecStart", `/opt/example/backup --version ${version}`],
      ],
      name: "Service",
    },
  ],
  started: false,
});

it.effect.prop(
  "a changed timer-managed oneshot is written and reloaded without interrupting its active run or refusing its completion",
  [Arbitrary.schema(Scenario)],
  ([scenario]) =>
    Effect.gen(function* spareRunningBackup() {
      const fake = yield* makeFakeShell();

      const before = yield* reconcileUnit(
        fake.shell,
        backup(scenario.version),
        undefined,
        false
      );

      yield* fake.shell.exec(["systemctl", "--user", "start", before.name]);
      yield* fake.clear();

      let reloaded = false;

      const shell: Interface = {
        ...fake.shell,
        exec: (argv, diagnostics) =>
          fake.shell.exec(argv, diagnostics).pipe(
            Effect.map((result) => {
              if (argv[2] === "daemon-reload") {
                reloaded = true;
              }

              return argv[2] === "show"
                ? {
                    ...result,
                    stdout: result.stdout.replace(
                      "ActiveState=active",
                      `ActiveState=${reloaded && scenario.finishes ? "inactive" : scenario.state}`
                    ),
                  }
                : result;
            })
          ),
      };

      const next = backup(scenario.version + 1);
      const after = yield* reconcileUnit(shell, next, before, false);
      const calls = yield* fake.calls();

      expect(after.active).toBe(!scenario.finishes);
      expect(after.sha256).not.toBe(before.sha256);
      expect(after.needDaemonReload).toBe(false);
      expect(calls.filter((call) => call.operation === "write")).toEqual([
        { argv: [after.path], operation: "write" },
      ]);
      expect(new TextDecoder().decode(yield* fake.shell.read(after.path))).toBe(
        renderUnit(next)
      );
      expect(
        calls.filter(
          (call) => call.argv[0] === "systemctl" && call.argv[2] !== "show"
        )
      ).toEqual([
        { argv: ["systemctl", "--user", "daemon-reload"], operation: "exec" },
      ]);
    })
);
