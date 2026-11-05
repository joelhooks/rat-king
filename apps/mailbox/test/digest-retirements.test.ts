import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { MailboxClientError } from "../../../packages/mailbox-client/src/error.ts";
import type { WakeSighting } from "../../../stacks/nest/alarm-wakes.ts";
import { digestRetirementObservations } from "../../../stacks/nest/digest-mail-collector.ts";

it.effect.prop(
  "the digest alone scans legacy retirement metadata once and never replaces authoritative per-name flags",
  {
    failed: Schema.Boolean,
    modes: Schema.Array(Schema.Literals(["new", "old", "missing"])).check(
      Schema.isMaxLength(12)
    ),
  },
  ({ failed, modes }) =>
    Effect.gen(function* digestProjection() {
      const seen: (typeof WakeSighting.Type)[] = modes.map((mode, index) => ({
        health:
          mode === "missing"
            ? null
            : {
                complete: true,
                lastAck: null,
                lease: null,
                oldestWake: null,
                quietUnacked: 0,
                ...(mode === "new" ? { retired: index % 2 === 0 } : undefined),
              },
        name: `reader-${index}`,
        owner: null,
        retired: mode === "new" ? index % 2 === 0 : null,
      }));

      let calls = 0;

      const scan = Effect.gen(function* scan() {
        calls += 1;

        if (failed) {
          return yield* new MailboxClientError({
            reason: "fixture unavailable",
          });
        }

        return seen.flatMap((item, index) =>
          index % 2 === 0 ? [] : [item.name]
        );
      });

      const result = yield* digestRetirementObservations(seen, scan);
      const scanned = modes.includes("old");
      expect(calls).toBe(scanned ? 1 : 0);
      expect(result.map((item) => item.retired)).toEqual(
        modes.map((mode, index) => {
          if (mode === "new") {
            return index % 2 === 0;
          }

          return scanned && !failed ? index % 2 !== 0 : null;
        })
      );
    })
);
