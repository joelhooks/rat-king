import { it } from "@effect/vitest";
import { Arbitrary, Clock, Duration, Effect, Fiber, Schema } from "effect";
import { expect } from "vitest";

import { runBackup, settleDelay } from "../../../stacks/nest/backup.ts";
import { advanceClock } from "./backup-clock.ts";

const name = "20000102T030405.123456Z-0123456789abcdef0123456789abcdef";

const staging = "/srv/example/.mailbox-backup-0123456789abcdef0123456789abcdef";

const outputs = new Map([
  ["pack", "4096"],
  ["share-commit", name],
  ["share-open", `.mailbox-publish-${name}`],
  ["stage", staging],
]);

const labelOf = (argv: readonly string[]) => {
  if (argv[0] === "curl") {
    return "health";
  }

  if (argv[0] === "systemctl") {
    return `${argv[2]} ${argv[3]}`;
  }

  return argv[0] === "python3" ? (argv[3] ?? "unknown") : "other";
};

it.effect.prop(
  "pack waits for celld health to answer and then for the settle delay",
  {
    refusals: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 0 }))
    ),
  },
  ({ refusals }) =>
    Effect.gen(function* settleGate() {
      const calls: { label: string; at: number }[] = [];
      let asked = 0;

      const shell = {
        exec: Effect.fn("SettleModel.exec")(function* exec(
          argv: readonly string[]
        ) {
          const label = labelOf(argv);
          calls.push({ at: yield* Clock.currentTimeMillis, label });

          if (label === "health") {
            asked += 1;

            return { code: asked > refusals ? 0 : 22, stdout: "" };
          }

          return { code: 0, stdout: outputs.get(label) ?? "" };
        }),
      };

      const fiber = yield* Effect.forkChild(
        runBackup(shell, {
          backupRoot: "/mnt/example",
          commit: "invented",
          dataRoot: "/srv/example",
          healthUrl: "http://127.0.0.1:1/health",
          home: "/home/example",
          version: "invented",
        })
      );

      yield* Effect.forkChild(advanceClock);
      yield* Fiber.join(fiber);

      const labels = calls.map((call) => call.label);
      const packed = calls[labels.indexOf("pack")];
      const answered = calls.findLast((call) => call.label === "health");

      expect(asked).toBe(refusals + 1);
      expect(labels.lastIndexOf("health")).toBeLessThan(labels.indexOf("pack"));
      expect(labels.indexOf("start rat-king-celld.service")).toBeLessThan(
        labels.indexOf("health")
      );
      expect((packed?.at ?? 0) - (answered?.at ?? 0)).toBeGreaterThanOrEqual(
        Duration.toMillis(settleDelay)
      );
    })
);
