import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { BACKUP_STOP_BUDGET_MS } from "../../../stacks/nest/alarm-maintenance.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import { alarmCycle, emptyJournal } from "../../../stacks/nest/alarm.ts";
import { digestMaintenanceReasons } from "../../../stacks/nest/digest.ts";
import { healthy, recorder, settings } from "./maintenance-fixtures.ts";

it.effect.prop(
  "backup-covered measurement failures stay visible as maintenance, then notify immediately outside the bounded cover",
  {
    ended: Schema.Boolean,
    start: Schema.Int.check(
      Schema.isBetween({ maximum: 10_000_000, minimum: 1_000_000 })
    ),
  },
  ({ ended, start }) =>
    Effect.gen(function* proof() {
      const end = start + BACKUP_STOP_BUDGET_MS;
      const backup = { end: ended ? start + 60_000 : null, start };
      const until = backup.end ?? end;

      const facts = {
        ...healthy,
        backup,
        failed: ["liveness"],
        measurementFailed: true,
      };

      const output = recorder();
      let journal = emptyJournal;
      let sources = emptySources;

      for (const now of [start, start + 1, until]) {
        const observed = observeAlarms(sources, facts, now);
        ({ sources } = observed);
        const { "digest.fail": reading } = observed.readings;
        expect(reading.status).toBe("maintenance");
        expect(digestMaintenanceReasons(sources, now).join(" ")).toContain(
          "Measurements unavailable: liveness"
        );
        expect(digestMaintenanceReasons(sources, now).join(" ")).toContain(
          "maintenance by backup"
        );
        journal = yield* alarmCycle(
          journal,
          facts,
          now,
          settings,
          output.ports
        );
      }

      expect(
        output.sent.filter((entry) => entry.key === "digest.fail")
      ).toHaveLength(0);
      expect(digestMaintenanceReasons(sources, start - 1)).toEqual([]);
      expect(digestMaintenanceReasons(sources, until + 1)).toEqual([]);

      const outside = observeAlarms(sources, facts, until + 1);
      expect(outside.readings["digest.fail"].status).toBe("firing");
      expect(digestMaintenanceReasons(outside.sources, until + 1)).toEqual([]);
      journal = yield* alarmCycle(
        journal,
        facts,
        until + 1,
        settings,
        output.ports
      );
      expect(output.sent.some((entry) => entry.key === "digest.fail")).toBe(
        true
      );
      expect(journal.alarms["digest.fail"]?.value).toBe("firing");

      for (const at of [start - 1, end + 1]) {
        const first = observeAlarms(emptySources, facts, at);
        expect(
          observeAlarms(first.sources, facts, at).readings["digest.fail"].status
        ).toBe("firing");
      }

      expect(
        observeAlarms(sources, { ...facts, digest: "fail" }, start).readings[
          "digest.fail"
        ].status
      ).toBe("firing");
      expect(
        observeAlarms(sources, { ...facts, measurementFailed: false }, start)
          .sources.measurementMaintenance
      ).toBeNull();
    })
);
