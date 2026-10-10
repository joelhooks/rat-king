import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  AgentName,
  canonicalName,
  deriveName,
  isReserved,
  provisionLabel,
  secretName,
} from "../src/name.ts";
import type { ReservedValue } from "../src/name.ts";

const reserved: ReservedValue = {
  "fleet-owner": {
    aliases: ["servo"],
    did: "did:web:fleet-owner.example.invalid",
  },
  switchboard: { did: "did:web:switchboard.example.invalid" },
};

const Label = Schema.String.check(Schema.isMaxLength(60));

const Session = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{1,40}$/u));

it.effect.prop(
  "a launcher's RATKING_NAME is used as given, with aliases mapped to their reserved name",
  [
    Arbitrary.schema(Schema.Union([AgentName, Schema.Literal("servo")])),
    Arbitrary.schema(Label),
    Arbitrary.schema(Session),
  ],
  ([name, label, session]) =>
    Effect.sync(() => {
      const result = deriveName({
        env: Option.some(name),
        pane: Option.some(label),
        reserved,
        session,
        taken: () => true,
      });

      expect(result).toEqual(
        Result.succeed({ name: canonicalName(reserved, name), source: "env" })
      );
    })
);

it.effect.prop(
  "a self-derived name is a valid agent name that is neither reserved nor taken",
  [
    Arbitrary.schema(Schema.Option(Label)),
    Arbitrary.schema(Session),
    Arbitrary.schema(Schema.Array(AgentName)),
  ],
  ([pane, session, takenNames]) =>
    Effect.sync(() => {
      const taken = new Set([...takenNames, "switchboard-pane"]);

      const result = deriveName({
        env: Option.none(),
        pane,
        reserved,
        session,
        taken: (name) => taken.has(name),
      });

      Result.match(result, {
        onFailure: (error) => {
          expect(error.reason).toMatch(/Session name pi-.* is already taken/u);
        },
        onSuccess: (own) => {
          expect(Schema.is(AgentName)(own.name)).toBe(true);
          expect(isReserved(reserved, own.name)).toBe(false);
          expect(taken.has(own.name)).toBe(false);
        },
      });
    })
);

it.effect.prop(
  "distinct names get distinct secret names, and every secret name is store-safe",
  [Arbitrary.schema(AgentName), Arbitrary.schema(AgentName)],
  ([a, b]) =>
    Effect.sync(() => {
      expect(secretName(a)).toMatch(/^[a-z][a-z0-9_.-]{0,127}$/u);
      expect(provisionLabel(a) === provisionLabel(b)).toBe(a === b);
    })
);
