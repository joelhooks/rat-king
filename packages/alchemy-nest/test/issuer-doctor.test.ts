import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";

const healthy: typeof AlarmFacts.Type = {
  cacheBreaches: null,
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
  slots: { free: 50, max: 100 },
};

it.prop(
  "doctor timeouts page at fifteen minutes and clear on either completed outcome",
  [Schema.Int.check(Schema.isBetween({ maximum: 1_800_000, minimum: 0 }))],
  ([elapsed]) => {
    const unavailable = {
      ...healthy,
      doctor: false,
      doctorFinished: false,
      doctorReasons: ["doctor probe timed out"],
    };

    const first = observeAlarms(emptySources, unavailable, 0);
    const before = observeAlarms(first.sources, unavailable, 899_999);
    const boundary = observeAlarms(before.sources, unavailable, 900_000);
    const later = observeAlarms(first.sources, unavailable, elapsed);

    expect(before.readings["doctor.unavailable"].status).toBe("ok");
    const reading = boundary.readings["doctor.unavailable"];

    expect(reading.status).toBe("firing");

    if (reading.status === "firing") {
      expect(reading.severity).toBe("warn");
      expect(reading.evidence).toContain("doctor probe timed out");
    }

    expect(later.readings["doctor.unavailable"].status).toBe(
      elapsed >= 900_000 ? "firing" : "ok"
    );
    expect(boundary.readings["issuer.broken"].status).toBe("ok");
    expect(boundary.readings["digest.fail"].status).toBe("ok");

    for (const doctor of [true, false]) {
      const completed = observeAlarms(
        boundary.sources,
        {
          ...healthy,
          doctor,
          doctorFinished: true,
        },
        900_001
      );

      expect(completed.readings["doctor.unavailable"].status).toBe("ok");
      const next = observeAlarms(completed.sources, unavailable, 1_800_000);
      expect(next.readings["doctor.unavailable"].status).toBe("ok");
    }
  }
);

const DoctorSample = Schema.Struct({
  elapsed: Schema.Int.check(
    Schema.isBetween({ maximum: 1_000_000, minimum: 0 })
  ),
  status: Schema.Literals(["ok", "fail", "unavailable"]),
});

interface Model {
  now: number;
  failures: number;
  since: number | undefined;
  unavailableSince: number | undefined;
  unavailableCount: number;
}

interface Real {
  sources: typeof emptySources;
}

const runModel: (effect: Effect.Effect<void>) => Promise<void> =
  Effect.runPromise;

const sampleCommand = (
  sample: typeof DoctorSample.Type
): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: Effect.fn("Test.issuer.model")(function* run(model: Model, real: Real) {
    model.now += sample.elapsed;

    if (sample.status === "fail") {
      model.since ??= model.now;
      model.failures += 1;
    } else {
      model.since = undefined;
      model.failures = 0;
    }

    if (sample.status === "unavailable") {
      model.unavailableSince ??= model.now;
      model.unavailableCount += 1;
    } else {
      model.unavailableSince = undefined;
    }

    const result = yield* Effect.sync(() =>
      observeAlarms(
        real.sources,
        {
          ...healthy,
          doctor: sample.status === "ok",
          doctorFinished: sample.status !== "unavailable",
        },
        model.now
      )
    );

    real.sources = result.sources;

    const reading = result.readings["issuer.broken"];

    expect(result.sources.doctorUnavailableCount ?? 0).toBe(
      model.unavailableCount
    );

    const unavailableSpan =
      model.unavailableSince === undefined
        ? 0
        : model.now - model.unavailableSince;

    expect(result.readings["doctor.unavailable"].status).toBe(
      unavailableSpan >= 900_000 ? "firing" : "ok"
    );

    if (sample.status === "fail") {
      const sustained =
        model.failures >= 3 && model.now - (model.since ?? model.now) > 120_000;

      expect(reading.status).toBe(sustained ? "firing" : "unknown");
    } else {
      expect(reading.status).toBe("ok");
    }
  }, runModel),
  toString: () => JSON.stringify(sample),
});

it.effect.prop(
  "unavailable and healthy samples break a consecutive issuer failure streak",
  [Schema.Array(DoctorSample)],
  ([samples]) =>
    Effect.promise(
      asyncModelRun.bind(
        undefined,
        () => ({
          model: {
            failures: 0,
            now: 0,
            since: undefined,
            unavailableCount: 0,
            unavailableSince: undefined,
          },
          real: { sources: emptySources },
        }),
        samples.map(sampleCommand)
      )
    )
);

it.prop(
  "issuer requires both three consecutive failures and more than two minutes",
  [Schema.Int.check(Schema.isBetween({ maximum: 240_000, minimum: 0 }))],
  ([span]) => {
    const facts = {
      ...healthy,
      doctor: false,
      doctorReasons: ["invalid identity"],
    };

    const first = observeAlarms(emptySources, facts, 0);
    const second = observeAlarms(first.sources, facts, span);
    const third = observeAlarms(second.sources, facts, span);

    expect(first.readings["issuer.broken"].status).toBe("unknown");
    expect(second.readings["issuer.broken"].status).toBe("unknown");
    expect(third.readings["issuer.broken"].status).toBe(
      span > 120_000 ? "firing" : "unknown"
    );

    if (third.readings["issuer.broken"].status === "firing") {
      expect(third.readings["issuer.broken"].severity).toBe("critical");
      expect(third.readings["issuer.broken"].evidence).toContain(
        "invalid identity"
      );
    }

    const pass = observeAlarms(third.sources, healthy, span + 1);
    const again = observeAlarms(pass.sources, facts, span + 240_000);

    expect(pass.readings["issuer.broken"].status).toBe("ok");
    expect(again.readings["issuer.broken"].status).toBe("unknown");
  }
);
