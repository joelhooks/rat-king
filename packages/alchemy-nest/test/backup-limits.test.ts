import { it } from "@effect/vitest";
import {
  Arbitrary,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  backupStopBudgetMs,
  precopyAlarmSeconds,
  precopyMaxLimit,
  stopRestartLimit,
} from "../../../stacks/nest/backup-limits.ts";
import {
  healthWait,
  packLimit,
  precopyLimit,
  runBackup,
  settleDelay,
  snapshotLimit,
} from "../../../stacks/nest/backup.ts";

const gib = 1_073_741_824;

const bytes = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 300 * gib, minimum: 0 }))
);

it.prop(
  "precopy and pack grow with source bytes, precopy caps at 90 minutes, and the global cap leaves restart room through 300 GiB",
  { a: bytes, b: bytes },
  ({ a, b }) => {
    const smaller = Math.min(a, b);
    const larger = Math.max(a, b);
    expect(Duration.toMillis(packLimit(larger))).toBeGreaterThanOrEqual(
      Duration.toMillis(packLimit(smaller))
    );
    expect(Duration.toMillis(precopyLimit(larger))).toBeGreaterThanOrEqual(
      Duration.toMillis(precopyLimit(smaller))
    );
    expect(Duration.toMinutes(packLimit(Math.min(a, 40 * gib)))).toBe(45);
    expect(
      Duration.toMillis(packLimit(Math.max(a, 40 * gib) + gib))
    ).toBeGreaterThan(Duration.toMillis(packLimit(Math.max(a, 40 * gib))));

    for (const [size, minutes] of [
      [0, 25],
      [100, 25],
      [112, 37],
      [165, 90],
      [300, 90],
    ] as const) {
      expect(Duration.toMinutes(precopyLimit(size * gib))).toBe(minutes);
    }

    const outer = Duration.toSeconds(precopyLimit(a));
    expect(precopyAlarmSeconds(precopyLimit(a))).toBe(outer - 10);
    expect(outer).toBeLessThanOrEqual(Duration.toSeconds(precopyMaxLimit));
    expect(Duration.toMinutes(precopyLimit(Math.min(a, 100 * gib)))).toBe(25);
    expect(Duration.toMinutes(precopyLimit(100 * gib + 1))).toBe(26);

    const preparation = [
      snapshotLimit,
      healthWait,
      settleDelay,
      stopRestartLimit,
    ].reduce(
      (total, limit) => total + Duration.toMillis(limit),
      backupStopBudgetMs
    );

    expect(Duration.toMillis(packLimit(300 * gib)) + preparation).toBeLessThan(
      Duration.toMillis(Duration.hours(10))
    );
  }
);

it.effect.prop(
  "the preflight byte total selects both precopy budgets and a hung warm copy fails before arming or quiescing",
  { sourceBytes: bytes },
  ({ sourceBytes }) =>
    Effect.gen(function* precopyTimeout() {
      const entered = yield* Deferred.make<null>();
      const calls: string[] = [];
      const lines: string[] = [];

      const capture = Logger.layer([
        Logger.make(({ message }) => {
          lines.push((Array.isArray(message) ? message : [message]).join(" "));
        }),
      ]);

      const shell = {
        exec: Effect.fn("PrecopyLimit.exec")(function* exec(
          argv: readonly string[]
        ) {
          const label =
            argv[0] === "systemctl"
              ? `${argv[2]} ${argv[3]}`
              : (argv[3] ?? "unknown");

          calls.push(label);

          if (label === "precopy") {
            expect(Number(argv[7])).toBe(
              precopyAlarmSeconds(precopyLimit(sourceBytes))
            );
            yield* Deferred.succeed(entered, null);

            return yield* Effect.never;
          }

          const outputs = new Map([
            [
              "stage",
              "/srv/example/.mailbox-backup-0123456789abcdef0123456789abcdef",
            ],
            [
              "preflight",
              `BACKUP_PREFLIGHT_PASSED ${JSON.stringify({ celld: { bytes: sourceBytes - Math.floor(sourceBytes / 2) }, seaweedfs: { bytes: Math.floor(sourceBytes / 2) } })}`,
            ],
          ]);

          return { code: 0, stdout: outputs.get(label) ?? "" };
        }),
      };

      const fiber = yield* runBackup(shell, {
        backupRoot: "/mnt/example",
        commit: "invented",
        dataRoot: "/srv/example",
        home: "/home/example",
        version: "invented",
      }).pipe(Effect.provide(capture), Effect.forkChild);

      yield* Deferred.await(entered);
      yield* TestClock.adjust(Duration.toMillis(precopyLimit(sourceBytes)) - 1);
      expect(calls).not.toContain("cleanup-staging");
      yield* TestClock.adjust(1);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("Backup step timed out");
      expect(calls).not.toContain("arm");
      expect(calls.some((call) => call.startsWith("stop "))).toBe(false);
      expect(calls.at(-1)).toBe("cleanup-staging");
      expect(
        lines.some((line) => line.startsWith("BACKUP_PRECOPY_CAPACITY"))
      ).toBe(sourceBytes > 165 * gib);
    })
);
