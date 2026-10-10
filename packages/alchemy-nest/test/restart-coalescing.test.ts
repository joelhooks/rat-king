import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { stageOwnedUnit } from "../../../stacks/nest/ship-unit-stage.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import type { UnitProps } from "../src/systemd.ts";
import { reconcileUnit } from "../src/systemd.ts";

it.effect.prop(
  "a dependency restart is coalesced only when the staged declaration is loaded and running process inputs are proven",
  [
    Schema.Struct({
      cascade: Schema.Boolean,
      known: Schema.Boolean,
      proved: Schema.Boolean,
      staged: Schema.Boolean,
    }),
  ],
  ([input]) =>
    Effect.gen(function* coalescing() {
      const fake = yield* makeFakeShell();

      const old: UnitProps = {
        home: "/home/example",
        name: "fixture.invalid.service",
        restartOn: ["old.invalid"],
        scope: "user" as const,
        sections: [
          { lines: [["ExecStart", "/opt/old"] as const], name: "Service" },
        ],
      };

      const next: UnitProps = {
        ...old,
        restartOn: ["new.invalid"],
        sections: [
          { lines: [["ExecStart", "/opt/new"] as const], name: "Service" },
        ],
      };

      const initial = yield* reconcileUnit(fake.shell, old, undefined, false);

      if (input.staged) {
        yield* stageOwnedUnit(fake.shell, next, { attr: initial });
        yield* fake.shell.exec(["systemctl", "--user", "daemon-reload"]);
      }

      if (input.cascade) {
        yield* fake.shell.exec(["systemctl", "--user", "restart", old.name]);
      }

      const observedInvocation = input.cascade
        ? "after.invalid"
        : "before.invalid";

      const invocation = input.known ? observedInvocation : "";

      const shell = {
        ...fake.shell,
        exec: (argv: readonly string[]) =>
          fake.shell.exec(argv).pipe(
            Effect.map((result) =>
              argv.includes("show")
                ? {
                    ...result,
                    stdout: `${result.stdout}InvocationID=${invocation}\n`,
                  }
                : result
            )
          ),
      };

      const before = (yield* fake.calls()).length;
      yield* reconcileUnit(
        shell,
        next,
        { ...initial, invocationId: "before.invalid" },
        false,
        Effect.succeed(input.proved)
      );

      const restarts = (yield* fake.calls())
        .slice(before)
        .filter((call) => call.argv.includes("restart"));

      expect(restarts).toHaveLength(
        input.cascade && input.known && input.staged && input.proved ? 0 : 1
      );
    })
);
