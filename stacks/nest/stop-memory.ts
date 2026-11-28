import { Result, Schema } from "effect";

const dayMs = 86_400_000;

const growthPolicy = {
  capFraction: 0.6,
  historyDays: 10,
  maxBaselineNights: 7,
  maxLatestAgeMs: 36 * 3_600_000,
  minBaselineNights: 3,
  minGrowthBytes: 512 * 1024 ** 2,
};

export const fleetMemoryLimits = {
  celld: "8G",
  seaweedfs: "4608M",
  slice: "14G",
} as const;

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const MemoryCharge = Schema.Struct({
  anon: Schema.optionalKey(Schema.NullOr(Bytes)),
  current: Schema.NullOr(Bytes),
  file: Schema.optionalKey(Schema.NullOr(Bytes)),
  max: Schema.NullOr(Bytes),
  peak: Schema.NullOr(Bytes),
});

const StopSample = Schema.Struct({
  at: Bytes,
  charge: MemoryCharge,
  unit: Schema.Literals(["celld", "seaweedfs"]),
});

export const StopMemoryHistory = Schema.Array(StopSample);

type StopSampleValue = typeof StopSample.Type;

type History = typeof StopMemoryHistory.Type;

export const StopMemory = Schema.Struct({
  celld: MemoryCharge,
  preStopHistory: Schema.optionalKey(StopMemoryHistory),
  seaweedfs: Schema.optionalKey(MemoryCharge),
  slice: Schema.optionalKey(MemoryCharge),
});

const chargeJson = Schema.decodeResult(Schema.fromJsonString(MemoryCharge));

export const readStopMemoryJournal = (output: string, at: number): History =>
  output.split("\n").flatMap((message): StopSampleValue[] => {
    const groups =
      /\bBACKUP_STOP_MEMORY rat-king-(?<unit>celld|seaweedfs)\.service (?<payload>.+)$/u.exec(
        message
      )?.groups;

    const { unit, payload } = groups ?? {};

    if ((unit !== "celld" && unit !== "seaweedfs") || payload === undefined) {
      return [];
    }

    const charge = chargeJson(payload);

    return Result.isSuccess(charge)
      ? [{ at, charge: charge.success, unit }]
      : [];
  });

export const rememberStopMemory = (
  prior: History,
  current: History,
  now: number
): History => {
  const byUnitNight = new Map<string, StopSampleValue>();

  for (const sample of [...prior, ...current]) {
    if (sample.at > now || now - sample.at > growthPolicy.historyDays * dayMs) {
      continue;
    }

    const key = `${sample.unit}/${Math.floor(sample.at / dayMs)}`;

    if (sample.at >= (byUnitNight.get(key)?.at ?? -1)) {
      byUnitNight.set(key, sample);
    }
  }

  return [...byUnitNight.values()].toSorted((a, b) => b.at - a.at);
};

const stopGrowth = (
  history: History,
  unit: StopSampleValue["unit"],
  cap: number,
  now: number
) => {
  const [latest, ...prior] = history.filter((sample) => sample.unit === unit);

  const anon = latest?.charge.anon;

  if (
    latest === undefined ||
    now - latest.at > growthPolicy.maxLatestAgeMs ||
    latest.charge.max !== cap ||
    anon === null ||
    anon === undefined ||
    anon / cap < growthPolicy.capFraction
  ) {
    return [];
  }

  const baseline = prior
    .flatMap(({ charge }) =>
      charge.max === cap && charge.anon !== null && charge.anon !== undefined
        ? [charge.anon]
        : []
    )
    .slice(0, growthPolicy.maxBaselineNights)
    .toSorted((a, b) => a - b);

  const upper = baseline[Math.floor(baseline.length / 2)];
  const lower = baseline[Math.ceil(baseline.length / 2) - 1];

  if (
    baseline.length < growthPolicy.minBaselineNights ||
    upper === undefined ||
    lower === undefined
  ) {
    return [];
  }

  const median = Math.floor((lower + upper) / 2);

  return anon - median >= growthPolicy.minGrowthBytes
    ? [
        {
          kind: "high" as const,
          text: `${unit} pre-stop anonymous memory grew to ${anon} bytes vs prior-night median ${median} bytes (${baseline.length} nights); at least ${growthPolicy.capFraction * 100}% of unit cap ${cap} bytes`,
        },
      ]
    : [];
};

export interface StopMemoryCheck {
  readonly kind: "unavailable" | "high";
  readonly text: string;
}

export const stopMemoryChecks = (
  memory: typeof StopMemory.Type,
  history: History,
  now: number
): StopMemoryCheck[] =>
  (["celld", "seaweedfs"] as const).flatMap((name): StopMemoryCheck[] => {
    const charge = memory[name];

    if (charge === undefined) {
      return [];
    }

    if (
      charge.anon === undefined ||
      charge.anon === null ||
      charge.max === null ||
      charge.max === 0
    ) {
      return [
        {
          kind: "unavailable" as const,
          text: `${name} anonymous memory accounting unavailable; inspect cgroup memory.stat and unit cap`,
        },
      ];
    }

    return stopGrowth(history, name, charge.max, now);
  });
