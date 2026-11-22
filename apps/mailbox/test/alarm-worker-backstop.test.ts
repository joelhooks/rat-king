import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { alarmPlist } from "../../../stacks/nest/alarm-command.ts";
import { LaunchdAlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  checkAlarmWorkerHealth,
  nextAlarmHeartbeat,
} from "../../../stacks/nest/alarm-heartbeat.ts";
import type { AlarmHeartbeat } from "../../../stacks/nest/alarm-heartbeat.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { runModel } from "./record-retired-model.ts";
import type { EffectCommand } from "./record-retired-model.ts";

it.effect.prop(
  "five consecutive failed cycles terminate the worker, success resets the count, and launchd keeps the launcher alive",
  [
    StageConfig,
    LaunchdAlarmSettings,
    Schema.Array(Schema.Boolean).check(Schema.isMaxLength(20)),
  ],
  ([base, alarm, outcomes]) =>
    Effect.gen(function* proof() {
      const commands: EffectCommand<
        { failures: number },
        { heartbeat: typeof AlarmHeartbeat.Type | null }
      >[] = [
        ...outcomes,
        true,
        false,
        false,
        false,
        false,
        false,
        true,
        false,
      ].map((ok) => ({
        check: () => true,
        run: (model, real) =>
          Effect.gen(function* cycle() {
            model.failures = ok ? 0 : model.failures + 1;
            real.heartbeat = nextAlarmHeartbeat(
              real.heartbeat,
              0,
              ok ? "ok" : "Alarm step notifications.send failed (FleetError)"
            );
            expect(
              yield* checkAlarmWorkerHealth(real.heartbeat).pipe(
                Effect.isFailure
              )
            ).toBe(model.failures >= 5);
            expect(real.heartbeat.consecutiveFailures).toBe(model.failures);
          }),
        toString: () => (ok ? "successful cycle" : "failed send cycle"),
      }));

      yield* runModel(
        () => ({ model: { failures: 0 }, real: { heartbeat: null } }),
        commands
      );

      const plist = alarmPlist(
        { ...base, alarm },
        "/fixture.invalid/config.json"
      );

      expect(plist).toContain("<key>KeepAlive</key><true/>");
      expect(plist).toContain(
        "<key>ThrottleInterval</key><integer>60</integer>"
      );
    })
);
