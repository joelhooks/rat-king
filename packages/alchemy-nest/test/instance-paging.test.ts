import { describe, expect, it } from "vitest";

import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type {
  AlarmFacts,
  InstanceHealth,
  SourceState,
} from "../../../stacks/nest/alarm-sources.ts";

const healthy: typeof AlarmFacts.Type = {
  cacheBreaches: [],
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
  slots: { free: 100, max: 100 },
};

const down = (name: string, page: boolean): typeof InstanceHealth.Type =>
  page
    ? { name, page: true, reason: "transport error", status: "down" }
    : { name, reason: "transport error", status: "down" };

const cycles = (
  readings: readonly (readonly (typeof InstanceHealth.Type)[])[]
) => {
  let sources: typeof SourceState.Type = emptySources;

  return readings.map((instances, index) => {
    const observed = observeAlarms(
      sources,
      { ...healthy, instances },
      60_000 * (index + 1)
    );

    ({ sources } = observed);

    return observed.readings["instance.down"];
  });
};

describe("instance paging", () => {
  it("pages a page:true instance only after two consecutive down cycles", () => {
    expect(
      cycles([[down("mischief", true)], [down("mischief", true)]])
    ).toEqual([
      { status: "unknown" },
      {
        evidence: "mischief: transport error",
        severity: "critical",
        status: "firing",
      },
    ]);
  });

  it("a single failed cycle between healthy ones never pages", () => {
    const readings = cycles([
      [down("mischief", true)],
      [{ name: "mischief", page: true, status: "ok" }],
      [down("mischief", true)],
    ]);

    expect(
      readings.map((reading) =>
        reading?.status === "firing" ? reading.severity : reading?.status
      )
    ).toEqual(["unknown", "ok", "unknown"]);
  });

  it("instances without page stay warn however long they are down", () => {
    const readings = cycles([
      [down("mischief", false)],
      [down("mischief", false)],
      [down("mischief", false)],
    ]);

    expect(
      readings
        .slice(1)
        .every(
          (reading) =>
            reading?.status === "firing" && reading.severity === "warn"
        )
    ).toBe(true);
  });

  it("a paging instance's count is not borrowed by another down instance", () => {
    const readings = cycles([
      [down("quiet", false), { name: "loud", page: true, status: "ok" }],
      [down("quiet", false), down("loud", true)],
    ]);

    expect(
      readings.map((reading) =>
        reading?.status === "firing" ? reading.severity : reading?.status
      )
    ).toEqual(["unknown", "warn"]);
  });

  it("leaves the source state shape unchanged when no instances are configured", () => {
    expect(observeAlarms(emptySources, healthy, 60_000).sources).toEqual(
      emptySources
    );
  });
});
