import { DateTime, Schema } from "effect";

export const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

export const id = integer(1, 60_000);

export const epoch = integer(1_700_000_000_000, 1_900_000_000_000);

export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const template = "did:web:example.invalid:agents:{agent}:identity";

export const alpha = (length: number) =>
  Schema.String.check(
    Schema.isPattern(/^[a-z]+$/u),
    Schema.isMaxLength(length)
  );
