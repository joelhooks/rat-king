import { it } from "@effect/vitest";
import { AgentName } from "@rat-king/ratking-client/name";
import { Arbitrary, ConfigProvider, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { collectFacts } from "../src/extension.ts";
import { autoName, NAME_ENTRY, parseNameEntries } from "../src/name.ts";

const uuid = Arbitrary.schema(Schema.String.check(Schema.isUUID(7)));

it.prop(
  "distinct UUIDv7 sessions in one millisecond get distinct valid agent names",
  [uuid, Arbitrary.array(uuid, { maxLength: 64, minLength: 64 })],
  ([clock, ids]) => {
    const timestamp = clock.slice(0, 14);

    const names = ids.flatMap((id, index) => {
      const rest = `${id.slice(16, -2)}${index.toString(16).padStart(2, "0")}`;

      return [
        autoName(`${timestamp}70${rest}`),
        autoName(`${timestamp}71${rest}`),
      ];
    });

    expect(new Set(names).size).toBe(names.length);
    expect(names.every(Schema.is(AgentName))).toBe(true);
  }
);

it.effect.prop(
  "resuming a Pi restores its recorded timestamp-prefix auto name",
  [uuid],
  ([id]) =>
    Effect.gen(function* restore() {
      const session = id.toLowerCase();
      const name = `pi-${session.slice(0, 8)}`;

      const entries = parseNameEntries([
        {
          customType: NAME_ENTRY,
          data: { derived: true, name, session, source: "interactive" },
          type: "custom",
        },
      ]);

      const facts = yield* collectFacts(session, undefined, true, entries).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
      );

      expect(facts.env).toEqual(Option.some(name));
      expect(facts.source).toBe("restored");
      expect(facts.derived).toBe(true);
    })
);
