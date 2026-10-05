import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { requireModel } from "../src/port.ts";

it.effect("refuses Sonnet and Fable before SDK startup", () =>
  Effect.gen(function* refuse() {
    for (const model of ["claude-sonnet-5", "claude-fable-5-1"]) {
      const result = yield* requireModel(model).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
  })
);
