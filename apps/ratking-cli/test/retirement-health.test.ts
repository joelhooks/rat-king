import { it } from "@effect/vitest";
import { Transport } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { readRetirements } from "../../../packages/mailbox-client/src/retirements.ts";

it.effect.prop(
  "retirement observations consume every page and fail rather than report an empty list on unavailable data",
  {
    pages: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 })),
    unavailable: Schema.Boolean,
  },
  ({ pages, unavailable }) =>
    Effect.gen(function* retirement() {
      let calls = 0;

      const transport = Transport.of({
        request: () => {
          calls += 1;

          return Effect.succeed({
            body: unavailable
              ? {}
              : {
                  ...(calls < pages ? { cursor: String(calls) } : undefined),
                  retired: [
                    {
                      by: "did:web:operator.invalid",
                      did: "did:web:reader.invalid",
                      name: `retired-${calls}`,
                      retiredAt: "2026-11-01T00:00:00.000Z",
                    },
                  ],
                },
            kind: "json" as const,
            status: unavailable ? 503 : 200,
          });
        },
      });

      if (unavailable) {
        expect(yield* readRetirements(transport).pipe(Effect.isFailure)).toBe(
          true
        );
      } else {
        expect(yield* readRetirements(transport)).toEqual(
          Array.from({ length: pages }, (_, index) => `retired-${index + 1}`)
        );
        expect(calls).toBe(pages);
      }
    })
);
