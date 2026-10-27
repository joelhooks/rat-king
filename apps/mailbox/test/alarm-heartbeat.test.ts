import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Schema } from "effect";
import { modelRun } from "fast-check";
import type { Command } from "fast-check";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  AlarmHeartbeat,
  alarmFailure,
  alarmHeartbeatFailure,
  nextAlarmHeartbeat,
  readAlarmHeartbeat,
  withAlarmHeartbeat,
  writeAlarmHeartbeat,
} from "../../../stacks/nest/alarm-heartbeat.ts";
import { Facts } from "../../../stacks/nest/health.ts";
import { FleetError, StageConfig } from "../../../stacks/nest/stage-config.ts";

it.effect.prop(
  "the independent digest fails on missing, malformed, stale or five failed cycles, but not healthy or four failed cycles",
  [StageConfig, AlarmSettings, Facts],
  ([base, alarm, facts]) =>
    Effect.gen(function* digestProof() {
      const config = { ...base, alarm: { ...alarm, enabled: true } };

      const digest = {
        ...facts,
        reasons: ["existing reason"],
        status: "warn" as const,
      };

      for (const consecutiveFailures of [0, 4, 5, 37]) {
        for (const at of [-300_001, -300_000, 0]) {
          const heartbeat = {
            at,
            consecutiveFailures,
            outcome:
              consecutiveFailures === 0
                ? ("ok" as const)
                : ("Alarm measurements unavailable" as const),
          };

          const result = yield* withAlarmHeartbeat(config, digest).pipe(
            Effect.provide(
              FileSystem.layerNoop({
                readFileString: () => Effect.succeed(JSON.stringify(heartbeat)),
              })
            )
          );

          expect(result.status).toBe(
            at < -300_000 || consecutiveFailures >= 5 ? "fail" : "warn"
          );
          expect(result.reasons).toContain("existing reason");

          if (at === 0 && consecutiveFailures >= 5) {
            expect(result.reasons).toContain(
              `alarm worker: ${consecutiveFailures} cycles failed in a row (Alarm measurements unavailable)`
            );
          }
        }
      }

      for (const text of ["", "malformed", "{}"]) {
        const result = yield* withAlarmHeartbeat(config, digest).pipe(
          Effect.provide(
            FileSystem.layerNoop({ readFileString: () => Effect.succeed(text) })
          )
        );

        expect(result.status).toBe("fail");
        expect(result.reasons).toContain(
          "alarm worker: heartbeat missing or unreadable"
        );
      }

      const missing = yield* withAlarmHeartbeat(config, digest).pipe(
        Effect.provide(FileSystem.layerNoop({}))
      );

      expect(missing.status).toBe("fail");
      expect(missing.reasons).toContain(
        "alarm worker: heartbeat missing or unreadable"
      );
      expect(
        yield* withAlarmHeartbeat(
          { ...config, alarm: { ...config.alarm, enabled: false } },
          digest
        ).pipe(Effect.provide(FileSystem.layerNoop({})))
      ).toEqual(digest);
      expect(
        alarmHeartbeatFailure(
          { at: 1, consecutiveFailures: 0, outcome: "ok" },
          0
        )
      ).toContain("clock invalid");
    }),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "cycle outcomes reset on success, survive private atomic replacement and restarts, and withhold input values",
  [
    Schema.Array(AlarmHeartbeat.fields.outcome).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20)
    ),
  ],
  ([outcomes]) =>
    Effect.gen(function* persistenceProof() {
      const fs = yield* FileSystem.FileSystem;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alarm-heartbeat-",
      });

      const commands: Command<
        { failures: number },
        { heartbeat: typeof AlarmHeartbeat.Type | null }
      >[] = outcomes.map((outcome) => ({
        check: () => true,
        run: (model, real) => {
          model.failures = outcome === "ok" ? 0 : model.failures + 1;
          real.heartbeat = nextAlarmHeartbeat(real.heartbeat, 1000, outcome);
          expect(real.heartbeat.consecutiveFailures).toBe(model.failures);
        },
        toString: () => outcome,
      }));

      modelRun(
        () => ({ model: { failures: 0 }, real: { heartbeat: null } }),
        commands
      );

      let failures = 0;

      for (const outcome of outcomes) {
        const previous = yield* readAlarmHeartbeat(directory);

        const heartbeat = nextAlarmHeartbeat(previous, 1000, outcome);

        failures = outcome === "ok" ? 0 : failures + 1;
        yield* writeAlarmHeartbeat(directory, heartbeat);
        expect(yield* readAlarmHeartbeat(directory)).toEqual({
          at: 1000,
          consecutiveFailures: failures,
          outcome,
        });

        const stat = yield* fs.stat(`${directory}/alarm-heartbeat.json`);

        expect(stat.mode % 0o1000).toBe(0o600);
        expect(yield* fs.readDirectory(directory)).toEqual([
          "alarm-heartbeat.json",
        ]);
      }

      expect(
        alarmFailure(
          new FleetError({ reason: "Alarm measurements unavailable" })
        )
      ).toBe("Alarm measurements unavailable");
      expect(alarmFailure(new Cause.TimeoutError())).toBe(
        "Alarm cycle timed out"
      );
      expect(
        alarmFailure(new FleetError({ reason: "private-input-invalid" }))
      ).toBe("Alarm operation unavailable");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  { arbitrary: { runs: 10 } }
);
