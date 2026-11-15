import { describe, expect, it } from "vitest";

import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";

const now = 1_000_000;

const missing = "config doctor did not finish within 30 seconds";

const facts = (
  doctorFinished: boolean,
  doctorReasons: readonly string[]
): typeof AlarmFacts.Type => ({
  cacheBreaches: null,
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: false,
  doctorFinished,
  doctorReasons,
  entered: now,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 50, max: 100 },
});

const twice = (input: typeof AlarmFacts.Type) => {
  const first = observeAlarms(emptySources, input, now);
  const second = observeAlarms(first.sources, input, now + 60_000);

  return observeAlarms(second.sources, input, now + 120_001).readings[
    "issuer.broken"
  ];
};

describe("issuer.broken on a doctor that never reported", () => {
  it("does not report broken identity when the doctor never checked it", () => {
    expect(twice(facts(false, [missing]))).toEqual({ status: "ok" });
  });

  it("a doctor that finished and found a sustained fault stays critical", () => {
    const reading = twice(
      facts(true, ["secondary: service issuer host identity is malformed"])
    );

    expect(reading.status).toBe("firing");

    if (reading.status === "firing") {
      expect(reading.severity).toBe("critical");
    }
  });
});
