import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { collectAlarmFacts } from "../../../stacks/nest/alarm-collector.ts";
import { LaunchdAlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import { Counts } from "../../../stacks/nest/comms.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { FleetError, StageConfig } from "../../../stacks/nest/stage-config.ts";

it.effect.prop(
  "collector preserves churn limits and routes doctor timeouts only to the sustained availability alarm",
  [StageConfig, ShipSettings, LaunchdAlarmSettings, Schema.Int, Counts],
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
            doctor: () => Effect.never,
          }
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust("31 seconds");
        const measured = yield* Fiber.join(facts);
        const first = observeAlarms(emptySources, measured, 0);
        const sustained = observeAlarms(first.sources, measured, 900_000);

        expect(measured.failed).not.toContain("doctor");
        expect(measured.doctorFinished).toBe(false);
        expect(first.readings["doctor.unavailable"].status).toBe("ok");
        expect(sustained.readings["doctor.unavailable"].status).toBe("firing");
        expect(sustained.readings["issuer.broken"].status).toBe("ok");

        expect(Object.hasOwn(measured, "churnLimit")).toBe(
          churnLimit !== undefined
        );
        expect(measured.churnLimit).toBe(churnLimit);
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
  [StageConfig, ShipSettings, LaunchdAlarmSettings, Counts, Schema.Int],
  ([base, ship, alarm, counts, status]) =>
    Effect.gen(function* proof() {
      const fixture = {
        ...base,
        alarm: {
          broadcast: alarm.broadcast,
          enabled: true,
          launchd: alarm.launchd,
          musterDesk: alarm.musterDesk,
          notify: alarm.notify,
          owners: alarm.owners,
        },
        comms: { local: base.comms.local },
        doctor: { primary: {} },
        ship,
      };

      const stage = Schema.fromJsonString(StageConfig);

      const config = yield* Schema.encodeEffect(stage)(fixture).pipe(
        Effect.flatMap(Schema.decodeEffect(stage))
      );

      const observed: string[] = [];

      const ports = {
        comms: (source: typeof base.comms.local) =>
          Effect.sync(() => {
            observed.push(source.receipts);

            return counts;
          }),
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
      expect(measured.failed).not.toContain("quarantine");
      expect(blind.failed).not.toContain("quarantine");
      expect(observed).toEqual([
        config.comms.local.receipts,
        config.comms.local.receipts,
      ]);
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) })
      ),
      Effect.provide([NodeServices.layer, FetchHttpClient.layer])
    ),
  { arbitrary: { runs: 10 } }
);
