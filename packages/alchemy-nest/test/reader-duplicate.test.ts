import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  emptySources,
  observeAlarms,
  sightReaders,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";

it.effect.prop(
  "readers.stuck ignores only SendOnly duplicates with a positively observed live lease held by a different session on that name",
  {
    health: Schema.Literals(["live", "expired", "missing", "unavailable"]),
    knownSession: Schema.Boolean,
    matchingName: Schema.Boolean,
    sameHolder: Schema.Boolean,
    state: Schema.Literals(["SendOnly", "Retrying", "Live"]),
  },
  ({ health, knownSession, matchingName, sameHolder, state }) =>
    Effect.sync(() => {
      const now = 1_000_000;
      const stamp = DateTime.makeUnsafe(0);

      const seen = sightReaders(
        "host.invalid",
        [
          {
            alive: true,
            beat: {
              lastConsumeOk: null,
              lastError: null,
              leaseHeldSince: null,
              name: "tester",
              owner: "desk",
              pid: 1,
              ...(knownSession ? { session: "reader" } : undefined),
              startedAt: stamp,
              state,
              updatedAt: DateTime.makeUnsafe(now),
            },
          },
        ],
        now
      );

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: null,
        deploy: null,
        deployKnown: true,
        digest: "ok",
        doctor: true,
        entered: 0,
        health: 200,
        measurementFailed: false,
        quarantinedHour: 0,
        readers: { complete: true, seen },
        receipts: [],
        receiptsKnown: true,
        slots: null,
        wakes: [
          {
            health:
              health === "unavailable"
                ? null
                : {
                    complete: true,
                    lastAck: null,
                    lease:
                      health === "missing"
                        ? null
                        : {
                            expiresAt: now + (health === "live" ? 1 : 0),
                            generation: 1,
                            holder: sameHolder ? "reader" : "other",
                            pane: null,
                          },
                    oldestWake: null,
                    quietUnacked: 0,
                  },
            name: matchingName ? "tester" : "unrelated",
            owner: "desk",
          },
        ],
      };

      const quiet =
        state === "SendOnly" &&
        knownSession &&
        matchingName &&
        health === "live" &&
        !sameHolder;

      const result = observeAlarms(emptySources, facts, now).readings[
        "readers.stuck"
      ];

      expect(result.status).toBe(quiet ? "ok" : "firing");

      if (result.status === "firing") {
        expect(result.recipients).toEqual(["desk"]);
      }
    })
);
