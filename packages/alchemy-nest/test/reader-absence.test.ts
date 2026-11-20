import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import type { WakeSighting } from "../../../stacks/nest/alarm-wakes.ts";
import { emptyJournal } from "../../../stacks/nest/alarm.ts";
import { healthy, MINUTE, recorder, runTicks } from "./maintenance-fixtures.ts";

const now = 1_800_000_000_000;

const fortnight = 14 * 24 * 60;

const key = "reader.absent/phone-fixture";

const sighting = (page: boolean, expiresAt: number, count: number) =>
  ({
    configured: true,
    health: {
      complete: false,
      lastAck: null,
      lease: { expiresAt, generation: 1, holder: "ios-fixture", pane: null },
      ...(count === 0
        ? undefined
        : { oldestUndeliveredAt: now - fortnight * MINUTE }),
      oldestWake: null,
      quietUnacked: 0,
      retired: false,
      undelivered: count,
    },
    name: "phone-fixture",
    owner: "phone-owner",
    page,
    unackedMinutes: 1440,
  }) satisfies typeof WakeSighting.Type;

it.effect.prop(
  "two weeks without a lease and 233 undelivered messages reaches only the configured owner",
  [Schema.Boolean],
  ([page]) =>
    Effect.gen(function* absent() {
      const io = recorder();

      const facts = {
        ...healthy,
        wakes: [sighting(page, now - fortnight * MINUTE, 233)],
      };

      yield* runTicks(
        emptyJournal,
        [
          { at: now, facts },
          { at: now + 11 * MINUTE, facts },
        ],
        io.ports
      );

      expect(io.sent).toHaveLength(1);
      expect(io.sent[0]).toMatchObject({ key, recipients: ["phone-owner"] });
      expect(io.sent[0]?.text).toContain(
        "phone-fixture: last lease ended 20160m ago; 233 undelivered message(s) waiting"
      );
      expect(io.pages).toHaveLength(page ? 1 : 0);
    })
);

for (const mode of ["live lease", "empty backlog"] as const) {
  it.effect.prop(
    `${mode} is observed but does not fire the absence alarm`,
    [Schema.Boolean],
    ([page]) =>
      Effect.gen(function* observed() {
        const io = recorder();

        const facts = {
          ...healthy,
          wakes: [
            mode === "live lease"
              ? sighting(page, now + MINUTE, 233)
              : sighting(page, now - fortnight * MINUTE, 0),
          ],
        };

        const journal = yield* runTicks(
          emptyJournal,
          [{ at: now, facts }],
          io.ports
        );

        expect(journal.alarms[key]?.value).toBe("ok");
        expect(io.sent).toEqual([]);
        expect(io.pages).toEqual([]);
      })
  );
}
