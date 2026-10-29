import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  MAX_WINDOW_MS,
  clock,
  coveringWindow,
  maintenancePath,
  readMaintenance,
} from "../../../stacks/nest/alarm-maintenance.ts";
import {
  resolveUntil,
  runMaintenance,
} from "../../../stacks/nest/maintenance-command.ts";

const T0 = 1_800_000_000_000;

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

it.effect.prop(
  "--until HH:MMZ resolves to the next time the UTC clock shows it, and never to the past or past 12 hours",
  { hour: Int(0, 23), minute: Int(0, 59), now: Int(0, 86_400_000 * 400) },
  ({ hour, minute, now }) =>
    Effect.sync(() => {
      const wall = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}Z`;
      const until = resolveUntil(wall, T0 + now);

      if (Result.isSuccess(until)) {
        expect(clock(until.success)).toBe(wall);
        expect(until.success).toBeGreaterThan(T0 + now);
        expect(until.success - (T0 + now)).toBeLessThanOrEqual(MAX_WINDOW_MS);
      } else {
        expect(until.failure).toContain("more than 12 hours away");
      }
    })
);

it.effect(
  "the CLI writes a window the alarm reads; end closes it after grace",
  () =>
    Effect.gen(function* roundTrip() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* TestClock.setTime(T0);

      yield* runMaintenance(
        directory,
        ["mischief"],
        [
          "start",
          "--instance",
          "mischief",
          "--until",
          "+30m",
          "--owner",
          "pi-durable/desk",
          "--reason",
          "Jev key deploy",
        ]
      );

      expect((yield* fs.stat(maintenancePath(directory))).mode % 0o1000).toBe(
        0o600
      );

      const declared = yield* readMaintenance(directory);
      const facts = { maintenance: declared };

      expect(coveringWindow(facts, "mischief", T0 + 34 * 60_000)).toMatchObject(
        { owner: "pi-durable/desk", reason: "Jev key deploy" }
      );
      expect(
        coveringWindow(facts, "mischief", T0 + 36 * 60_000)
      ).toBeUndefined();
      expect(coveringWindow(facts, "other", T0 + 60_000)).toBeUndefined();

      yield* TestClock.setTime(T0 + 10 * 60_000);
      yield* runMaintenance(
        directory,
        ["mischief"],
        ["end", "--instance", "mischief"]
      );

      const ended = { maintenance: yield* readMaintenance(directory) };

      expect(coveringWindow(ended, "mischief", T0 + 15 * 60_000)).toBeDefined();
      expect(
        coveringWindow(ended, "mischief", T0 + 16 * 60_000)
      ).toBeUndefined();

      const refusals = yield* Effect.forEach(
        [
          ["end", "--instance", "mischief"],
          [
            "start",
            "--instance",
            "typo",
            "--until",
            "+5m",
            "--owner",
            "pi-durable/desk",
            "--reason",
            "x",
          ],
          [
            "start",
            "--instance",
            "mischief",
            "--until",
            "+13h",
            "--owner",
            "pi-durable/desk",
            "--reason",
            "x",
          ],
          [
            "start",
            "--instance",
            "mischief",
            "--until",
            "+5m",
            "--owner",
            "Not A Name",
            "--reason",
            "x",
          ],
        ],
        (argv) => Effect.exit(runMaintenance(directory, ["mischief"], argv))
      );

      expect(refusals.every(Exit.isFailure)).toBe(true);
      expect(yield* readMaintenance(directory)).toEqual(ended.maintenance);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
