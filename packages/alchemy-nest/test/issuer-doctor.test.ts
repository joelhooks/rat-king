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

const DoctorSample = Schema.Struct({
  elapsed: Schema.Int.check(Schema.isBetween({ maximum: 180_000, minimum: 0 })),
  status: Schema.Literals(["ok", "fail", "unavailable"]),
});

interface Model {
  now: number;
  failures: number;
  since: number | undefined;
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

    if (sample.status === "unavailable") {
      expect(reading).toMatchObject({ severity: "warn", status: "firing" });
    } else if (sample.status === "ok") {
      expect(reading.status).toBe("ok");
    } else {
      const sustained =
        model.failures >= 3 && model.now - (model.since ?? model.now) > 120_000;

      expect(reading.status).toBe(sustained ? "firing" : "unknown");
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
          model: { failures: 0, now: 0, since: undefined },
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
