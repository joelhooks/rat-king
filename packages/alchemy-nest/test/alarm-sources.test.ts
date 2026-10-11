import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";

const Inputs = Schema.Struct({
  age: Schema.Int.check(Schema.isBetween({ maximum: 181, minimum: -1 })),
  doctor: Schema.Boolean,
  explained: Schema.Boolean,
  free: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 0 })),
  quarantine: Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 0 })),
  reader: Schema.Literals(["present", "missing", "inactive", "unknown"]),
});

it.effect.prop(
  "source evidence gates downtime, restart accounting, lease absence, storage thresholds and quarantine growth",
  [Inputs],
  ([input]) =>
    Effect.sync(() => {
      const now = 1_000_000;

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
        readers: { "desk.invalid": input.reader },
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
        input.doctor ? "ok" : "firing"
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

      const expectedReader = {
        inactive: "ok",
        missing: "firing",
        present: "ok",
        unknown: "unknown",
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
          readers: { "desk.invalid": "unknown" },
          receiptsKnown: false,
          slots: null,
        },
        later + 60_000
      );

      expect(uncertain.readings["filer.slots"].status).toBe("unknown");
      expect(uncertain.readings["ship.failed"].status).toBe("unknown");
      expect(uncertain.readings["readers.stuck"].status).toBe("unknown");
      expect(uncertain.readings["quarantine.growth"].status).toBe("unknown");
      expect(uncertain.readings["digest.fail"].status).toBe("firing");
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
        readers: {},
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
