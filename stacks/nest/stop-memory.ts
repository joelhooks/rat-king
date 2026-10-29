import { Schema } from "effect";

export const anonWarningFraction = 0.6;

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

export const StopMemory = Schema.Struct({
  celld: MemoryCharge,
  seaweedfs: Schema.optionalKey(MemoryCharge),
  slice: Schema.optionalKey(MemoryCharge),
});

export interface StopMemoryCheck {
  readonly kind: "unavailable" | "high";
  readonly text: string;
}

export const stopMemoryChecks = (
  memory: typeof StopMemory.Type
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

    return charge.anon / charge.max >= anonWarningFraction
      ? [
          {
            kind: "high" as const,
            text: `${name} anonymous memory ${charge.anon} bytes is at least 60% of unit cap ${charge.max} bytes; inspect anonymous growth before the nightly backup`,
          },
        ]
      : [];
  });

export const stopMemoryWarnings = (memory: typeof StopMemory.Type) =>
  stopMemoryChecks(memory).map((check) => check.text);
