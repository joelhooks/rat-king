import { it } from "@effect/vitest";
import { Arbitrary, DateTime, Schema } from "effect";
import { expect } from "vitest";

import {
  sessionsBackupReading,
  SessionsBackupFact,
  SESSIONS_BACKUP_MAX_AGE_MS,
} from "../../../stacks/nest/alarm-backups.ts";
import {
  AlarmSourcesOff,
  alarmSourceMetadata,
} from "../../../stacks/nest/alarm-config.ts";
import { recallCanaryReading } from "../../../stacks/nest/alarm-recall.ts";
import {
  deployWindow,
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import { healthy, settings } from "./maintenance-fixtures.ts";
import {
  day,
  epoch,
  integer,
  minute,
  positive,
} from "./nest-rule-generators.ts";

const switches = Schema.Struct({
  doctor: Schema.optionalKey(Schema.Boolean),
  quarantine: Schema.optionalKey(Schema.Boolean),
  receipts: Schema.optionalKey(Schema.Boolean),
});

it.prop(
  "source metadata contains exactly the explicit opt-outs and omits the empty object",
  [switches],
  ([sources]) => {
    const result = alarmSourceMetadata({ ...settings, sources });

    const disabled = Object.entries(sources)
      .filter(([, value]) => !value)
      .map(([name]) => name);

    expect(result.alarmSources ?? {}).toEqual(
      Object.fromEntries(disabled.map((name) => [name, "off"]))
    );
    expect(Object.hasOwn(result, "alarmSources")).toBe(disabled.length > 0);
  }
);

it.prop(
  "an explicitly disabled source remains off even if its underlying observation is bad",
  [AlarmSourcesOff, epoch, positive],
  ([alarmSources, now, count]) => {
    const { readings } = observeAlarms(
      {
        ...emptySources,
        doctorFailureSince: now - 10 * minute,
        doctorMisses: count,
      },
      {
        ...healthy,
        alarmSources,
        doctor: false,
        quarantinedHour: count,
        receiptsKnown: false,
      },
      now
    );

    const keys = {
      doctor: ["issuer.broken", "doctor.unavailable"],
      quarantine: ["quarantine.growth"],
      receipts: ["ship.churn", "ship.failed"],
    } as const;

    for (const source of ["doctor", "quarantine", "receipts"] as const) {
      for (const key of keys[source]) {
        expect(readings[key]?.status === "off").toBe(
          alarmSources[source] === "off"
        );
      }
    }
  }
);

it.prop(
  "the eighth day is still fresh; any excess raises only a warning",
  [epoch, positive],
  ([completedAt, excess]) => {
    const fact = { alarm: null, completedAt };
    const deadline = completedAt + SESSIONS_BACKUP_MAX_AGE_MS;
    expect(sessionsBackupReading(fact, deadline)).toEqual({ status: "ok" });
    expect(sessionsBackupReading(fact, deadline + excess)).toMatchObject({
      severity: "warn",
      status: "firing",
    });
  }
);

it.prop(
  "a session backup alarm takes precedence over any receipt, fresh or absent",
  [SessionsBackupFact, epoch, positive],
  ([fact, now, age]) => {
    const alarm = `raised-${age}`;
    expect(sessionsBackupReading({ ...fact, alarm }, now)).toEqual({
      evidence: `backup ALARM file raised at ${alarm}`,
      severity: "warn",
      status: "firing",
    });
  }
);

it.prop(
  "session backup evidence reports whole days without rounding up",
  [epoch, integer(9, 90), integer(1, day - 1)],
  ([completedAt, days, partial]) => {
    expect(
      sessionsBackupReading(
        { alarm: null, completedAt },
        completedAt + days * day + partial
      )
    ).toMatchObject({ evidence: `last success ${days} days ago` });
  }
);

it.prop(
  "a recall alarm wins even if the stored receipt passes",
  [epoch, positive],
  ([reportedAt, label]) => {
    const at = DateTime.formatIso(DateTime.makeUnsafe(reportedAt));
    const alarm = `raised-${label}`;

    expect(
      recallCanaryReading({ alarm, receipt: { at, status: "pass" } })
    ).toEqual({
      evidence: `recall canary ALARM raised at ${alarm}`,
      severity: "warn",
      status: "firing",
    });
  }
);

it.prop(
  "an arbitrary receipt status other than pass never clears recall",
  [positive, epoch],
  ([code, now]) => {
    const at = DateTime.formatIso(DateTime.makeUnsafe(now));
    expect(
      recallCanaryReading({
        alarm: null,
        receipt: { at, status: `fail-${code}` },
      })
    ).toMatchObject({ severity: "warn", status: "firing" });
    expect(
      recallCanaryReading({ alarm: null, receipt: { at, status: "pass" } })
    ).toEqual({ status: "ok" });
  }
);

const freeSlots = (free: number, max: number) =>
  observeAlarms(emptySources, { ...healthy, slots: { free, max } }, 0).readings[
    "filer.slots"
  ];

it.prop(
  "slot alarm severity drops from critical to warning at 5% free",
  [positive],
  ([scale]) => {
    const max = 20 * scale;
    expect(freeSlots(scale - 1, max)).toMatchObject({
      severity: "critical",
      status: "firing",
    });
    expect(freeSlots(scale, max)).toMatchObject({
      severity: "warn",
      status: "firing",
    });
  }
);

it.prop("slot alarm clears at exactly 10% free", [positive], ([scale]) => {
  const max = 10 * scale;
  expect(freeSlots(scale - 1, max)).toMatchObject({ status: "firing" });
  expect(freeSlots(scale, max)).toEqual({ status: "ok" });
});

it.prop(
  "arbitrary slot counts with no capacity measurement stay unknown",
  [integer(0, 10_000)],
  ([free]) => {
    expect(freeSlots(free, 0)).toEqual({ status: "unknown" });
  }
);

const CacheList = Arbitrary.schema(
  Schema.Array(integer(10, 100)).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(8)
  )
);

it.prop(
  "repeat breaches by one session never count as distinct sessions for critical severity",
  [epoch, CacheList],
  ([now, rewrites]) => {
    const hour = DateTime.formatIso(DateTime.makeUnsafe(now));

    const breaches = rewrites.map((fullRewrites) => ({
      fullRewrites,
      host: "example",
      hour,
      session: "demo",
    }));

    const reading = (cacheBreaches: typeof breaches) =>
      observeAlarms(emptySources, { ...healthy, cacheBreaches }, now).readings[
        "cache.rewrites"
      ];

    expect(reading(breaches)).toMatchObject({
      severity: "warn",
      status: "firing",
    });
    expect(
      reading(breaches.map((item, i) => ({ ...item, session: `demo-${i}` })))
    ).toMatchObject({ severity: "critical", status: "firing" });
  }
);

it.prop(
  "the deploy restart shield covers its start but expires at three minutes",
  [integer(1_700_000_000, 1_900_000_000)],
  ([started]) => {
    const facts = {
      ...healthy,
      deploy: { phase: "restarting" as const, sha: "a".repeat(40), started },
    };

    const start = started * 1000;
    expect(deployWindow(facts, start - 1)).toBe(false);
    expect(deployWindow(facts, start)).toBe(true);
    expect(deployWindow(facts, start + 3 * minute - 1)).toBe(true);
    expect(deployWindow(facts, start + 3 * minute)).toBe(false);
  }
);
