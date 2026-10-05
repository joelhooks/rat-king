/* oxlint-disable unicorn/no-array-sort, unicorn/no-useless-spread -- Generated clients target ES2022; sort only a copied array. */
import { Schema, SchemaGetter } from "effect";

export const BooleanFromQuery = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  })
);

export const Value = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

export const Params = Schema.Record(Schema.String, Value);

export const entries = (
  params: typeof Params.Type
): readonly (readonly [string, string])[] =>
  [...Object.entries(params)]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      if (Schema.is(Schema.String)(value)) {
        return [[key, value] satisfies readonly [string, string]];
      }

      return value.map(
        (item) => [key, item] satisfies readonly [string, string]
      );
    });

export const parameters = (pairs: readonly (readonly [string, string])[]) => {
  const grouped = new Map<string, string | readonly string[]>();

  for (const [key, value] of pairs) {
    const previous = grouped.get(key);

    if (previous === undefined) {
      grouped.set(key, value);
    } else if (Schema.is(Schema.String)(previous)) {
      grouped.set(key, [previous, value]);
    } else {
      grouped.set(key, [...previous, value]);
    }
  }

  return Object.fromEntries(grouped);
};
