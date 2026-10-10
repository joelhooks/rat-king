import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
