import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import { collectAlarmFacts } from "../../../stacks/nest/alarm-collector.ts";
import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import { Counts } from "../../../stacks/nest/comms.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { FleetError, StageConfig } from "../../../stacks/nest/stage-config.ts";

it.effect.prop(
  "collector decodes facts and omits an absent churn limit, preserving configured limits",
  [StageConfig, ShipSettings, AlarmSettings, Schema.Int, Counts],
  ([base, ship, alarm, limit, counts]) =>
    Effect.gen(function* proof() {
      const restart = { ...ship.restart };
      delete restart.churnLimit;

      const config = {
        ...base,
        alarm: {
          broadcast: alarm.broadcast,
          enabled: true,
          launchd: alarm.launchd,
          musterDesk: alarm.musterDesk,
          notify: alarm.notify,
          owners: alarm.owners,
          page: alarm.page,
        },
        ship: { ...ship, restart },
      };

      for (const churnLimit of [undefined, limit]) {
        const facts = yield* collectAlarmFacts(
          {
            ...config,
            ship: {
              ...config.ship,
              restart: {
                ...restart,
                ...(churnLimit === undefined ? undefined : { churnLimit }),
              },
            },
          },
          Effect.fail("health unavailable"),
          Effect.succeed(null),
          undefined,
          undefined,
          {
            comms: () => Effect.succeed(counts),
            doctor: () =>
              Effect.succeed({ reasons: [], status: "ok" as const }),
          }
        );

        expect(Object.hasOwn(facts, "churnLimit")).toBe(
          churnLimit !== undefined
        );
        expect(facts.churnLimit).toBe(churnLimit);
      }
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) })
      ),
      Effect.provide([NodeServices.layer, FetchHttpClient.layer])
    ),
  { arbitrary: { runs: 10 } }
);

it.effect.prop(
  "a failed health digest does not hide the mailbox status the liveness probe read, and the digest falls back when liveness fails",
  [StageConfig, ShipSettings, AlarmSettings, Counts, Schema.Int],
  ([base, ship, alarm, counts, status]) =>
    Effect.gen(function* proof() {
      const config = {
        ...base,
        alarm: {
          broadcast: alarm.broadcast,
          enabled: true,
          launchd: alarm.launchd,
          musterDesk: alarm.musterDesk,
          notify: alarm.notify,
          owners: alarm.owners,
          page: alarm.page,
        },
        ship,
      };

      const ports = {
        comms: () => Effect.succeed(counts),
        doctor: () => Effect.succeed({ reasons: [], status: "ok" as const }),
      };

      const measured = yield* collectAlarmFacts(
        config,
        Effect.fail("digest unavailable"),
        Effect.succeed(null),
        undefined,
        undefined,
        { ...ports, liveness: Effect.succeed(status) }
      );

      expect(measured.health).toBe(status);
      expect(measured.failed).toContain("health");
      expect(measured.failed).not.toContain("liveness");

      const blind = yield* collectAlarmFacts(
        config,
        Effect.fail("digest unavailable"),
        Effect.succeed(null),
        undefined,
        undefined,
        {
          ...ports,
          liveness: Effect.fail(new FleetError({ reason: "unreachable" })),
        }
      );

      expect(blind.health).toBeNull();
      expect(blind.failed).toContain("liveness");
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) })
      ),
      Effect.provide([NodeServices.layer, FetchHttpClient.layer])
    ),
  { arbitrary: { runs: 10 } }
);
