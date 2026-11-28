import { Schema } from "effect";

export const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

export const epoch = integer(1_700_000_000_000, 1_900_000_000_000);

export const positive = integer(1, 60_000);

export const minute = 60_000;

export const day = 1440 * minute;

export const gib = 1024 ** 3;
