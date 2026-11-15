import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  RESTART_MEMORY_MS,
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";

const Inputs = Schema.Struct({
  age: Schema.Int.check(Schema.isBetween({ maximum: 181, minimum: -1 })),
  doctor: Schema.Boolean,
  explained: Schema.Boolean,
  free: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
  quarantine: Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 0 })),
  reader: Schema.Literals(["complete", "partial", "unconfigured"]),
});

it.effect.prop(
  "source evidence gates downtime, restart accounting, lease absence, storage thresholds and quarantine growth",
  [Inputs],
  ([input]) =>
    Effect.sync(() => {
      const now = 1_000_000;

      const running = {
        host: "host.invalid",
        idleSeconds: 30,
        lastError: null,
        name: "desk-invalid",
        owner: null,
        state: "Live",
        verdict: "running" as const,
      };

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: null,
        deploy: {
          phase: "restarting",
          started: (now - input.age * 1000) / 1000,
        },
        deployKnown: true,
        digest: "ok",
        doctor: input.doctor,
        entered: now,
        health: 503,
        measurementFailed: false,
        quarantinedHour: input.quarantine,
        readers:
          input.reader === "unconfigured"
            ? null
            : { complete: input.reader === "complete", seen: [running] },
        receipts: [],
        receiptsKnown: true,
        slots: { free: input.free, max: 100 },
      };

      const first = observeAlarms(emptySources, facts, now);
      const second = observeAlarms(first.sources, facts, now);
      const active = input.age >= 0 && input.age < 180;
      expect(second.readings["celld.down"].status).toBe(
        active ? "unknown" : "firing"
      );
      expect(second.readings["filer.slots"].status).toBe(
        input.free < 10 ? "firing" : "ok"
      );
      const slots = second.readings["filer.slots"];

      if (slots.status === "firing") {
        expect(slots.severity).toBe(input.free < 5 ? "critical" : "warn");
      }

      expect(second.readings["quarantine.growth"].status).toBe(
        input.quarantine > 20 ? "firing" : "ok"
      );
      expect(second.readings["issuer.broken"].status).toBe(
        input.doctor ? "ok" : "unknown"
      );
      const later = now + 600_000;

      const receipts = input.explained
        ? [
            {
              celldRestarted: true,
              end: later / 1000,
              restartSeconds: 10,
              result: "success" as const,
              sha: "a".repeat(40),
              start: now / 1000,
            },
          ]
        : [];

      const third = observeAlarms(
        second.sources,
        { ...facts, deploy: null, entered: later, health: 200, receipts },
        later
      );

      expect(third.readings["celld.down"].status).toBe("ok");
      expect(third.readings["celld.restarted"].status).toBe(
        input.explained ? "ok" : "firing"
      );

      const hourLater = later + RESTART_MEMORY_MS;

      const fourth = observeAlarms(
        third.sources,
        { ...facts, deploy: null, entered: later, health: 200, receipts },
        hourLater
      );

      expect(fourth.readings["celld.restarted"].status).toBe("ok");

      const expectedReader = {
        complete: "ok",
        partial: "unknown",
        unconfigured: "unknown",
      } as const;

      expect(third.readings["readers.stuck"].status).toBe(
        expectedReader[input.reader]
      );

      const uncertain = observeAlarms(
        third.sources,
        {
          ...facts,
          health: 200,
          measurementFailed: true,
          quarantinedHour: null,
          readers: { complete: false, seen: [running] },
          receiptsKnown: false,
          slots: null,
        },
        later + 60_000
      );

      expect(uncertain.readings["filer.slots"].status).toBe("unknown");
      expect(uncertain.readings["ship.failed"].status).toBe("unknown");
      expect(uncertain.readings["readers.stuck"].status).toBe("unknown");
      expect(uncertain.readings["quarantine.growth"].status).toBe("unknown");
      expect(uncertain.readings["digest.fail"].status).toBe("unknown");

      const stillUncertain = observeAlarms(
        uncertain.sources,
        {
          ...facts,
          health: 200,
          measurementFailed: true,
          quarantinedHour: null,
          readers: { complete: false, seen: [running] },
          receiptsKnown: false,
          slots: null,
        },
        later + 120_000
      );

      expect(stillUncertain.readings["digest.fail"].status).toBe("firing");
    })
);

const Breaches = Schema.Struct({
  duplicate: Schema.Boolean,
  hoursAgo: Schema.Array(
    Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 0 }))
  ),
  known: Schema.Boolean,
});

it.effect.prop(
  "cache rebuild breaches fire only for recent hours, page only at three or more sessions, and stay unknown without the feed",
  [Breaches],
  ([input]) =>
    Effect.sync(() => {
      const now = Date.parse("2026-10-11T04:30:00Z");

      const spread = input.hoursAgo.map((ago, index) => ({
        fullRewrites: 20 - (index % 4),
        host: "host-a.invalid",
        hour: DateTime.formatIso(DateTime.makeUnsafe(now - ago * 3_600_000)),
        name: null,
        session: `session-${index % 4}`,
      }));

      const repeated = [0, 1].map((ago) => ({
        fullRewrites: 99 - ago,
        host: "host-a.invalid",
        hour: DateTime.formatIso(DateTime.makeUnsafe(now - ago * 3_600_000)),
        name: null,
        session: "session-9",
      }));

      const cacheBreaches = input.duplicate ? [...spread, ...repeated] : spread;

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: input.known ? cacheBreaches : null,
        deploy: null,
        deployKnown: true,
        digest: "ok",
        doctor: true,
        entered: null,
        health: 200,
        measurementFailed: false,
        quarantinedHour: 0,
        readers: null,
        receipts: [],
        receiptsKnown: true,
        slots: { free: 100, max: 100 },
      };

      const reading = observeAlarms(emptySources, facts, now).readings[
        "cache.rewrites"
      ];

      const recent = new Set([
        ...input.hoursAgo.flatMap((ago, index) => (ago < 2 ? [index % 4] : [])),
        ...(input.duplicate ? [9] : []),
      ]).size;

      if (!input.known) {
        expect(reading.status).toBe("unknown");

        return;
      }

      expect(reading.status).toBe(recent === 0 ? "ok" : "firing");

      if (reading.status === "firing") {
        expect(reading.severity).toBe(recent >= 3 ? "critical" : "warn");

        const named = reading.evidence.match(/session-\d+/gu) ?? [];

        expect(new Set(named).size).toBe(named.length);
      }
    })
);

const at = (time: string) => Date.parse(`2026-10-11T${time}Z`);

const Replay = Schema.Struct({
  cadence: Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 15 })),
  offset: Schema.Int.check(Schema.isBetween({ maximum: 59, minimum: 0 })),
});

it.effect.prop(
  "the 10:07 outage pages celld.down once the failed deploy's receipt exists, though deploy.json stays restarting",
  [Replay],
  ([{ cadence, offset }]) =>
    Effect.sync(() => {
      const sha = "b".repeat(40);
      const down = at("10:07:46");

      const receipt = {
        celldRestarted: null,
        end: at("10:07:47") / 1000,
        restartSeconds: null,
        result: "failed" as const,
        sha,
        start: at("10:04:00") / 1000,
      };

      let sources = emptySources;
      let paged: number | undefined;

      for (
        let now = at("10:06:00") + (offset % cadence) * 1000;
        now < at("10:12:00") && paged === undefined;
        now += cadence * 1000
      ) {
        const observed = observeAlarms(
          sources,
          {
            cacheBreaches: null,
            deploy: {
              phase: "restarting",
              sha,
              started: at("10:07:15") / 1000,
            },
            deployKnown: true,
            digest: "ok",
            doctor: true,
            entered: null,
            health: now < down ? 200 : 503,
            measurementFailed: false,
            quarantinedHour: 0,
            readers: null,
            receipts: now >= receipt.end * 1000 ? [receipt] : [],
            receiptsKnown: true,
            slots: null,
          },
          now
        );

        ({ sources } = observed);
        const { "celld.down": reading } = observed.readings;

        if (reading.status === "firing" && reading.severity === "critical") {
          paged = now;
        }
      }

      expect(paged).toBeDefined();
      expect(paged).toBeLessThanOrEqual(
        receipt.end * 1000 + 2 * cadence * 1000
      );
    })
);

it.effect.prop(
  "ship.churn alarms, without blocking, exactly when ship restarts in the last 24h exceed the limit",
  [
    Schema.Struct({
      limit: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
      old: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
      recent: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 0 })),
    }),
  ],
  ([input]) =>
    Effect.sync(() => {
      const now = 200_000_000;

      const receipt = (hoursAgo: number) => ({
        celldRestarted: true,
        end: now / 1000 - hoursAgo * 3600,
        restartSeconds: 10,
        result: "success" as const,
        sha: "a".repeat(40),
        start: now / 1000 - hoursAgo * 3600 - 20,
      });

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: null,
        churnLimit: input.limit,
        deploy: null,
        deployKnown: true,
        digest: "ok",
        doctor: true,
        entered: now,
        health: 200,
        measurementFailed: false,
        quarantinedHour: 0,
        readers: null,
        receipts: [
          ...Array.from({ length: input.old }, () => receipt(30)),
          ...Array.from({ length: input.recent }, () => receipt(2)),
        ],
        receiptsKnown: true,
        slots: { free: 100, max: 100 },
      };

      const { readings } = observeAlarms(emptySources, facts, now);

      expect(readings["ship.churn"].status).toBe(
        input.recent > input.limit ? "firing" : "ok"
      );
    })
);
