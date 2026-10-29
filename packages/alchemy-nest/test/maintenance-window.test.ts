import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  BACKUP_STOP_BUDGET_MS,
  MAILBOX_INSTANCE,
  clock,
} from "../../../stacks/nest/alarm-maintenance.ts";
import type { MaintenanceWindowValue } from "../../../stacks/nest/alarm-maintenance.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { emptyJournal } from "../../../stacks/nest/alarm.ts";
import { assess } from "../../../stacks/nest/health.ts";
import type { HealthFacts } from "../../../stacks/nest/health.ts";
import {
  MINUTE,
  down,
  healthy,
  recorder,
  runTicks,
} from "./maintenance-fixtures.ts";

const T0 = 1_800_000_000_000;

const Minutes = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

const window = (
  instance: string,
  length: number,
  grace: number,
  owner = "desk-a"
): MaintenanceWindowValue => ({
  graceMinutes: grace,
  instance,
  owner,
  reason: "Jev key deploy",
  start: T0,
  until: T0 + length * MINUTE,
});

const minutes = (from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => T0 + (from + index) * MINUTE
  );

it.effect.prop(
  "a declared restart stays quiet: no page, no broadcast, one notice to the window owner per key",
  { grace: Minutes(0, 15), length: Minutes(2, 90) },
  ({ grace, length }) =>
    Effect.gen(function* quiet() {
      const { pages, ports, sent } = recorder();

      const facts: typeof AlarmFacts.Type = {
        ...down(healthy, ["instance-a"]),
        health: 503,
        maintenance: [
          window("instance-a", length, grace),
          window(MAILBOX_INSTANCE, length, grace, "desk-m"),
        ],
      };

      const journal = yield* runTicks(
        emptyJournal,
        minutes(0, length + grace).map((at) => ({ at, facts })),
        ports
      );

      expect(pages).toEqual([]);
      expect(
        sent
          .map((item) => [item.key, item.recipients])
          .toSorted((left, right) => String(left).localeCompare(String(right)))
      ).toEqual([
        ["celld.down", ["desk-m"]],
        ["instance.down", ["desk-a"]],
      ]);

      for (const item of sent) {
        expect(item.text).toContain("maintenance by");
        expect(item.text).toContain(`ends ${clock(T0 + length * MINUTE)}`);
      }

      expect(journal.alarms["instance.down"]?.value ?? "ok").toBe("ok");
      expect(journal.alarms["celld.down"]?.value ?? "ok").toBe("ok");
    })
);

it.effect.prop(
  "an overrun past the end plus grace alarms as usual, names the window and pages after the confirm rule",
  { grace: Minutes(0, 15), length: Minutes(2, 90), over: Minutes(1, 40) },
  ({ grace, length, over }) =>
    Effect.gen(function* overrun() {
      const { pages, ports, sent } = recorder();

      const facts: typeof AlarmFacts.Type = {
        ...down(healthy, ["instance-a"]),
        maintenance: [window("instance-a", length, grace)],
      };

      const end = length + grace;

      const journal = yield* runTicks(
        emptyJournal,
        minutes(0, end + over).map((at) => ({ at, facts })),
        ports
      );

      const fired = sent.filter(
        (item) => item.key === "instance.down" && item.text.startsWith("🚨")
      );

      expect(fired.length).toBeGreaterThan(0);
      expect(fired[0]?.recipients).toContain("observer-invalid");
      expect(fired[0]?.text).toContain(
        `overran maintenance by desk-a (Jev key deploy) that ended ${clock(T0 + length * MINUTE)}`
      );
      expect(journal.alarms["instance.down"]?.value).toBe("firing");

      expect(pages).toHaveLength(over >= 11 ? 1 : 0);

      if (over >= 11) {
        expect(pages[0]).toContain("instance.down critical");
        expect(pages[0]).toContain("overran maintenance by desk-a");
      }
    })
);

it.effect.prop(
  "an undeclared down alarms exactly as before, and a window for instance A never covers instance B or the mailbox",
  {
    ended: Schema.Boolean,
    grace: Minutes(0, 15),
    length: Minutes(1, 600),
    pattern: Schema.Array(
      Schema.Struct({ b: Schema.Boolean, mailbox: Schema.Boolean })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  },
  ({ ended, grace, length, pattern }) =>
    Effect.gen(function* exact() {
      const ticks = (maintenance?: readonly MaintenanceWindowValue[]) =>
        pattern.map((step, index) => {
          const facts: typeof AlarmFacts.Type = {
            ...down(healthy, step.b ? ["instance-b"] : []),
            health: step.mailbox ? 503 : 200,
          };

          return {
            at: T0 + index * 7 * MINUTE,
            facts:
              maintenance === undefined ? facts : { ...facts, maintenance },
          };
        });

      const a = window("instance-a", length, grace);

      const run = (maintenance?: readonly MaintenanceWindowValue[]) => {
        const recorded = recorder();

        return runTicks(emptyJournal, ticks(maintenance), recorded.ports).pipe(
          Effect.map((journal) => ({
            alarms: journal.alarms,
            pages: recorded.pages,
            sent: recorded.sent,
          }))
        );
      };

      const before = yield* run();

      expect(yield* run([])).toEqual(before);
      expect(yield* run([ended ? { ...a, ended: T0 + MINUTE } : a])).toEqual(
        before
      );

      const both = down(healthy, ["instance-a", "instance-b"]);
      const plain = down(healthy, ["instance-b"]);
      const at = T0 + MINUTE;

      const covered = observeAlarms(
        emptySources,
        { ...both, maintenance: [a] },
        at
      ).readings["instance.down"];

      expect(covered).toEqual(
        observeAlarms(emptySources, plain, at).readings["instance.down"]
      );
      expect(covered.status).toBe("firing");
      expect(JSON.stringify(covered)).not.toContain("instance-a");
    })
);

it.effect.prop(
  "the backup's implicit window covers the mailbox stop and stop-memory accounting, and no longer",
  {
    duration: Schema.NullOr(Minutes(0, 120)),
    offset: Minutes(-10, 90),
  },
  ({ duration, offset }) =>
    Effect.sync(() => {
      const start = T0;
      const end = duration === null ? null : start + duration * MINUTE;
      const now = start + offset * MINUTE;

      const coverEnd =
        end === null
          ? start + BACKUP_STOP_BUDGET_MS
          : Math.min(end, start + BACKUP_STOP_BUDGET_MS);

      const covered = start <= now && now <= coverEnd;

      const facts: typeof AlarmFacts.Type = {
        ...healthy,
        backup: { end, start },
        health: 503,
        stopMemory: {
          celld: { anon: null, current: null, max: null, peak: null },
        },
      };

      const first = observeAlarms(emptySources, facts, now - MINUTE);
      const { readings } = observeAlarms(first.sources, facts, now);

      expect(readings["celld.down"].status).toBe(
        covered ? "maintenance" : "firing"
      );
      expect(readings["digest.fail"].status).toBe(
        covered ? "maintenance" : "firing"
      );

      if (covered) {
        expect(readings["celld.down"]).toMatchObject({
          evidence: `mailbox: maintenance by backup, ends ${clock(start + BACKUP_STOP_BUDGET_MS)}`,
          recipients: [],
        });
      } else {
        expect(JSON.stringify(readings["digest.fail"])).toContain(
          "accounting unavailable"
        );
        expect(readings["digest.fail"]).toMatchObject({ severity: "warn" });
        expect(readings["celld.down"]).toMatchObject({ severity: "critical" });
      }
    })
);

const at = (ms: number) => DateTime.makeUnsafe(ms);

const hostFacts = (now: number, start: number): HealthFacts => ({
  backup: {
    lastRun: {
      endedAt: null,
      memoryPeak: null,
      result: "success",
      startedAt: at(start),
      stopMs: null,
    },
    newest: {
      ageHours: 1,
      archiveBytes: 1,
      format: 4,
      name: "20261009T123419.326905Z-00000000000000000000000000000000",
    },
    nextRun: null,
  },
  health: { latencyMs: null, status: null },
  listeners: null,
  observedAt: at(now),
  retention: null,
  services: {
    celld: {
      activeEnterTimestamp: null,
      activeState: "inactive",
      nRestarts: 0,
    },
    seaweedfs: {
      activeEnterTimestamp: null,
      activeState: "inactive",
      nRestarts: 0,
    },
  },
  stopMemory: { celld: { anon: null, current: null, max: null, peak: null } },
  storage: { dataDirs: null, objects: null, slots: null },
  unavailable: {},
});

it.effect.prop(
  "a health digest taken during the backup stop reports stopped units as maintenance, and fails once the stop budget is spent",
  { offset: Minutes(0, 90) },
  ({ offset }) =>
    Effect.sync(() => {
      const verdict = assess(hostFacts(T0 + offset * MINUTE, T0));

      if (offset * MINUTE <= BACKUP_STOP_BUDGET_MS) {
        expect(verdict.status).toBe("ok");
        expect(verdict.reasons).toEqual([
          "maintenance by backup: health unreachable",
          "maintenance by backup: celld inactive",
          "maintenance by backup: seaweedfs inactive",
          "maintenance by backup: celld anonymous memory accounting unavailable; inspect cgroup memory.stat and unit cap",
        ]);
      } else {
        expect(verdict.status).toBe("fail");
        expect(verdict.reasons).toContain("celld inactive");
      }
    })
);
