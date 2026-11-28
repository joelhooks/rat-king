import { it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { expect } from "vitest";

import {
  assess,
  backupAgeHours,
  parseShow,
  retentionRefusedFrom,
  serviceLimits,
  stopMsFrom,
  summarize,
  unixInstant,
} from "../../../stacks/nest/health.ts";
import type { HealthFacts } from "../../../stacks/nest/health.ts";
import {
  day,
  epoch,
  integer,
  minute,
  positive,
} from "./nest-rule-generators.ts";

const at = DateTime.makeUnsafe;

const run = {
  endedAt: null,
  memoryPeak: null,
  result: "success",
  startedAt: null,
  stopMs: null,
} satisfies NonNullable<HealthFacts["backup"]["lastRun"]>;

const healthy = (now: number): HealthFacts => ({
  backup: {
    lastRun: null,
    newest: { ageHours: 0, archiveBytes: 1, format: 4, name: "example" },
    nextRun: null,
  },
  health: { latencyMs: 0, status: 200 },
  listeners: null,
  observedAt: at(now),
  retention: null,
  services: { celld: null, seaweedfs: null },
  storage: { dataDirs: null, objects: null, slots: null },
  unavailable: {},
});

it.prop(
  "stop duration warns at one millisecond over the budget, not at the budget",
  [epoch, positive],
  ([now, excess]) => {
    const base = healthy(now);

    const stop = (stopMs: number) =>
      assess({
        ...base,
        backup: { ...base.backup, lastRun: { ...run, stopMs } },
      });

    expect(stop(75_000)).toEqual({ reasons: [], status: "ok" });
    expect(stop(75_000 + excess)).toEqual({
      reasons: [`backup stop ${75_000 + excess} ms`],
      status: "warn",
    });
  }
);

it.prop(
  "an expected listener count differs from either an undercount or an overcount",
  [epoch, positive, positive],
  ([now, count, difference]) => {
    for (const [actual, expected] of [
      [count, count + difference],
      [count + difference, count],
    ] as const) {
      expect(
        assess({ ...healthy(now), listeners: { count: actual, expected } })
      ).toEqual({
        reasons: [`listeners ${actual}/${expected}`],
        status: "fail",
      });
    }
  }
);

it.prop(
  "foreign listener evidence fails even if the expected count balances",
  [epoch, positive],
  ([now, count]) => {
    const foreign = [`foreign listener on port ${count}`];
    expect(
      assess({
        ...healthy(now),
        listeners: { count, expected: count, foreign },
      })
    ).toEqual({ reasons: foreign, status: "fail" });
  }
);

it.prop(
  "critical storage alarms cannot be covered by a backup stop",
  [epoch, integer(1, 60)],
  ([now, elapsed]) => {
    const base = healthy(now);

    const facts = {
      ...base,
      backup: {
        ...base.backup,
        lastRun: { ...run, startedAt: at(now - elapsed * minute) },
      },
      health: { latencyMs: null, status: null },
      storage: { ...base.storage, slots: { alarm: true, free: 100, max: 100 } },
    };

    expect(assess(facts)).toEqual({
      reasons: ["storage alarm", "maintenance by backup: health unreachable"],
      status: "fail",
    });
  }
);

it.prop(
  "free-slot warnings clear at exactly one-quarter capacity",
  [epoch, positive],
  ([now, quarter]) => {
    const base = healthy(now);
    const max = quarter * 4;

    const assessSlots = (free: number) =>
      assess({
        ...base,
        storage: { ...base.storage, slots: { alarm: false, free, max } },
      });

    expect(assessSlots(quarter)).toEqual({ reasons: [], status: "ok" });
    expect(assessSlots(quarter - 1)).toEqual({
      reasons: [`free volume slots ${quarter - 1}/${max}`],
      status: "warn",
    });
  }
);

it.prop(
  "a known restart counter warns independently of how old the service start is",
  [epoch, integer(1, 24), positive, Schema.Literals(["celld", "seaweedfs"])],
  ([now, days, nRestarts, name]) => {
    const facts = healthy(now);

    const unit = {
      activeEnterTimestamp: at(now - days * day),
      activeState: "active",
      nRestarts,
    };

    expect(
      assess({ ...facts, services: { ...facts.services, [name]: unit } })
    ).toEqual({
      reasons: [`${name} restarted ${nRestarts} times`],
      status: "warn",
    });
  }
);

it.prop(
  "an explicitly ended backup no longer explains an unreachable HTTP probe",
  [epoch, positive],
  ([ended, lag]) => {
    const base = healthy(ended);

    const evaluate = (now: number) =>
      assess({
        ...base,
        backup: {
          ...base.backup,
          lastRun: {
            ...run,
            endedAt: at(ended),
            startedAt: at(ended - minute),
          },
        },
        health: { latencyMs: null, status: null },
        observedAt: at(now),
      });

    expect(evaluate(ended)).toEqual({
      reasons: ["maintenance by backup: health unreachable"],
      status: "ok",
    });
    expect(evaluate(ended + lag)).toEqual({
      reasons: ["health unreachable"],
      status: "fail",
    });
  }
);

it.prop(
  "capacity and retention warnings survive alongside a harder health failure",
  [epoch, integer(500, 599)],
  ([now, status]) => {
    const base = healthy(now);
    expect(
      assess({
        ...base,
        backup: {
          ...base.backup,
          lastRun: { ...run, precopyCapacity: true, retentionRefused: true },
        },
        health: { latencyMs: null, status },
      })
    ).toEqual({
      reasons: [
        `health ${status}`,
        "backup precopy capacity exceeded; inspect storage throughput",
        "backup retention refused",
      ],
      status: "fail",
    });
  }
);

it.prop(
  "a matching backup invocation cannot hide an unreadable unrelated measurement",
  [epoch, positive],
  ([now, id]) => {
    const base = healthy(now);
    const field = `probe-${id}`;
    expect(
      assess({
        ...base,
        backup: {
          ...base.backup,
          lastRun: { ...run, startedAt: at(now - minute) },
        },
        unavailable: { [field]: "timed out" },
      })
    ).toEqual({ reasons: [`${field} unavailable: timed out`], status: "warn" });
  }
);

it.prop(
  "the digest summary distinguishes a measured zero from missing telemetry",
  [epoch, positive],
  ([now, max]) => {
    const base = healthy(now);

    const values = {
      ...base,
      backup: { ...base.backup, lastRun: { ...run, stopMs: 0 } },
      listeners: { count: 0, expected: max },
      storage: { ...base.storage, slots: { alarm: false, free: 0, max } },
    };

    const summary = summarize({ ...values, ...assess(values) });
    expect(summary).toContain(`listeners 0/${max}`);
    expect(summary).toContain(`slots 0/${max}`);
    expect(summary).toContain("stop 0ms");
  }
);

it.prop(
  "systemd show parsing keeps nested equals in values and lets a later measurement win",
  [positive, positive],
  ([a, b]) => {
    const parsed = parseShow(
      `Unknown line\nMode= old=${a}\nMode= new=${b} \nOther=${a}`
    );

    expect([...parsed]).toEqual([
      ["Mode", `new=${b}`],
      ["Other", `${a}`],
    ]);
  }
);

it.prop(
  "service caps above the safe integer boundary retain their exact decimal form",
  [integer(1, 60_000)],
  ([extra]) => {
    const cap = String(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(extra));
    expect(serviceLimits(new Map([["MemoryMax", cap]]))).toEqual({
      memoryMax: cap,
    });
  }
);

const processProps = (value: string) =>
  new Map([
    ["MainPID", value],
    ["MemoryMax", "infinity"],
  ]);

it.prop(
  "a malformed PID is unknown, whereas zero positively reports no main process",
  [positive],
  ([pid]) => {
    expect(serviceLimits(processProps(`${pid}garbage`))).toEqual({
      memoryMax: "infinity",
    });
    expect(serviceLimits(processProps("0"))).toEqual({
      mainPidPresent: false,
      memoryMax: "infinity",
    });
    expect(serviceLimits(processProps(String(pid)))).toEqual({
      mainPidPresent: true,
      memoryMax: "infinity",
    });
  }
);

it.prop(
  "Unix service timestamps remain second-based even when systemd supplies a fraction",
  [integer(1_700_000_000, 1_900_000_000), positive],
  ([seconds, fraction]) => {
    expect(unixInstant(`@${seconds}.${fraction}`)).toEqual(at(seconds * 1000));
    expect(unixInstant(`${seconds}.${fraction}`)).toBeNull();
  }
);

it.prop(
  "backup age is derived from the archive timestamp rather than its suffix",
  [positive, integer(1, 120)],
  ([id, hours]) => {
    const created = Date.UTC(2026, 0, 1, 12, 34, 56);
    expect(
      backupAgeHours(
        `20260101T123456.${id}Z-example`,
        at(created + hours * 60 * minute)
      )
    ).toBe(hours);
  }
);

it.prop(
  "retention alarms from an earlier publication do not taint the latest one",
  [positive, positive],
  ([older, newer]) => {
    const journal = `BACKUP_PUBLISHED ${older}\nBACKUP_RETENTION_ALARM expired\nBACKUP_PUBLISHED ${newer}`;
    expect(retentionRefusedFrom(journal)).toBe(false);
    expect(
      retentionRefusedFrom(`${journal}\nBACKUP_RETENTION_ALARM current`)
    ).toBe(true);
  }
);

it.prop(
  "stop duration comes from the latest well-formed receipt, not from an earlier entry",
  [positive, positive],
  ([older, latest]) => {
    expect(
      stopMsFrom(
        `BACKUP_STOP_MS ${older}\nBACKUP_STOP_MS ${latest}\nBACKUP_STOP_MS missing`
      )
    ).toBe(latest);
  }
);
