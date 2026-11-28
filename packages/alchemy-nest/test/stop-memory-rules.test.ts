import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import {
  MemoryCharge,
  readStopMemoryJournal,
  rememberStopMemory,
  stopMemoryChecks,
} from "../../../stacks/nest/stop-memory.ts";
import type { StopMemoryHistory } from "../../../stacks/nest/stop-memory.ts";
import { day, epoch, integer, positive } from "./nest-rule-generators.ts";

const unit = Schema.Literals(["celld", "seaweedfs"]);

const mib = 1024 ** 2;

const growth = 512 * mib;

const cap = 5000 * mib;

const night = 20_000 * day;

const sample = (
  at: number,
  anon: number,
  name: typeof unit.Type = "celld",
  max = cap
) => ({ at, charge: { anon, current: null, max, peak: null }, unit: name });

const check = (history: typeof StopMemoryHistory.Type, now: number) =>
  stopMemoryChecks({ celld: sample(now, 0).charge }, history, now);

it.prop(
  "journal samples retain measured accounting values and the supplied observation instant",
  [MemoryCharge, unit, epoch],
  ([charge, name, at]) => {
    const line = `INFO BACKUP_STOP_MEMORY rat-king-${name}.service ${JSON.stringify(charge)}`;
    expect(
      readStopMemoryJournal(
        `irrelevant\n${line}\nBACKUP_STOP_MEMORY rat-king-${name}.service {`,
        at
      )
    ).toEqual([{ at, charge, unit: name }]);
  }
);

it.prop(
  "slice telemetry can never be mistaken for a comparable service sample",
  [MemoryCharge, epoch],
  ([charge, at]) => {
    expect(
      readStopMemoryJournal(
        `BACKUP_STOP_MEMORY rat-king.slice ${JSON.stringify(charge)}`,
        at
      )
    ).toEqual([]);
  }
);

it.prop(
  "same-night retries count once per service and the last observation survives",
  [positive, positive],
  ([first, second]) => {
    const early = sample(night + first, mib);
    const late = sample(early.at + second, 2 * mib);
    const other = { ...early, unit: "seaweedfs" as const };
    expect(rememberStopMemory([late, other], [early], late.at)).toEqual([
      late,
      other,
    ]);
  }
);

it.prop(
  "replayed samples leave remembered history unchanged",
  [
    Schema.Array(
      Schema.Struct({ ago: integer(0, 12 * day), anon: integer(0, cap), unit })
    ).check(Schema.isMaxLength(24)),
    epoch,
  ],
  ([rows, now]) => {
    const current = rows.map(({ ago, anon, unit: name }) =>
      sample(now - ago, anon, name)
    );

    const remembered = rememberStopMemory([], current, now);
    expect(rememberStopMemory(remembered, current, now)).toEqual(remembered);
  }
);

it.prop(
  "the history horizon includes ten-day old samples but rejects older and future samples",
  [epoch, positive],
  ([now, lag]) => {
    const old = sample(now - 10 * day, mib);
    expect(
      rememberStopMemory(
        [],
        [sample(now - 10 * day - lag, mib), sample(now + lag, mib), old],
        now
      )
    ).toEqual([old]);
  }
);

it.prop(
  "only three comparable historical nights make growth judgeable",
  [integer(0, 2), integer(3100, 4900)],
  ([noise, high]) => {
    const latest = sample(night, high * mib);

    const history = [
      latest,
      sample(night - day, mib),
      sample(night - 2 * day, mib),
      sample(night - 3 * day, mib, "celld", cap + noise + 1),
      sample(night - 4 * day, mib, "seaweedfs"),
    ];

    expect(check(history, night)).toEqual([]);
    expect(
      check([...history, sample(night - 5 * day, mib)], night)
    ).toMatchObject([{ kind: "high" }]);
  }
);

it.prop(
  "pre-stop growth warns at the inclusive 60% cap threshold",
  [integer(1, 2400)],
  ([normal]) => {
    const prior = [1, 2, 3].map((ago) =>
      sample(night - ago * day, normal * mib)
    );

    expect(check([sample(night, 3000 * mib - 1), ...prior], night)).toEqual([]);
    expect(check([sample(night, 3000 * mib), ...prior], night)).toMatchObject([
      { kind: "high" },
    ]);
  }
);

it.prop(
  "an even baseline uses the median pair, not the mean or either middle value",
  [integer(2600, 3300)],
  ([middle]) => {
    const prior = [1, middle - 100, middle + 100, 4999].map((anon, i) =>
      sample(night - (i + 1) * day, anon * mib)
    );

    const latest = middle * mib + growth;
    expect(check([sample(night, latest - 1), ...prior], night)).toEqual([]);
    expect(check([sample(night, latest), ...prior], night)).toMatchObject([
      { kind: "high" },
    ]);
  }
);

it.prop(
  "growth ceases to warn one millisecond after the latest sample reaches 36 hours",
  [integer(3100, 4800)],
  ([anon]) => {
    const history = [
      sample(night, anon * mib),
      ...[1, 2, 3].map((ago) => sample(night - ago * day, mib)),
    ];

    const deadline = night + (36 * day) / 24;
    expect(check(history, deadline)).toMatchObject([{ kind: "high" }]);
    expect(check(history, deadline + 1)).toEqual([]);
  }
);

it.prop(
  "no more than seven baseline nights can influence the warning",
  [integer(3100, 4800), integer(1, 2000)],
  ([anon, low]) => {
    const history = [
      sample(night, anon * mib),
      ...Array.from({ length: 7 }, (_, i) =>
        sample(night - (i + 1) * day, i < 4 ? cap - mib : low * mib)
      ),
    ];

    const oldest = [8, 9, 10].map((ago) =>
      sample(night - ago * day, low * mib)
    );

    expect(check([...history, ...oldest], night)).toEqual([]);
  }
);

it.prop(
  "missing anonymous accounting cannot be interpreted as zero growth",
  [MemoryCharge, unit],
  ([charge, name]) => {
    const missing = { ...charge, anon: null, max: cap };
    const normal = sample(night, 0).charge;

    const checks = stopMemoryChecks(
      { celld: normal, [name]: missing },
      [],
      night
    );

    expect(checks.map(({ kind }) => kind)).toEqual(["unavailable"]);
    expect(checks[0]?.text).toContain(name);
  }
);
