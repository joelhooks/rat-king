import { Schema } from "effect";

export const stopReserveBytes = 2_684_354_560;

export const stopWarningBytes = 3_221_225_472;

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const MemoryCharge = Schema.Struct({
  current: Schema.NullOr(Bytes),
  max: Schema.NullOr(Bytes),
  peak: Schema.NullOr(Bytes),
});

export const StopMemory = Schema.Struct({
  celld: MemoryCharge,
  slice: MemoryCharge,
});

export const stopMemoryWarnings = (memory: typeof StopMemory.Type) =>
  Object.entries(memory).flatMap(([name, charge]) => {
    if (charge.current === null || charge.max === null) {
      return [
        `${name} shutdown memory headroom unavailable; inspect unit memory accounting before backup`,
      ];
    }

    const free = charge.max - charge.current;

    return free < stopWarningBytes
      ? [
          `${name} shutdown memory headroom ${free} bytes; backup needs ${stopReserveBytes}; inspect memory growth before the nightly stop`,
        ]
      : [];
  });
