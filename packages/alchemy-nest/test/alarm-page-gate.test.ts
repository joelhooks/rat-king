import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { MAILBOX_INSTANCE } from "../../../stacks/nest/alarm-maintenance.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { emptyJournal } from "../../../stacks/nest/alarm.ts";
import {
  MINUTE,
  down,
  healthy,
  recorder,
  runTicks,
} from "./maintenance-fixtures.ts";

const T0 = 1_800_000_000_000;

const Int = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

const mailbox = (status: number): typeof AlarmFacts.Type => ({
  ...healthy,
  health: status,
});

it.effect.prop(
  "warn never pages, however long it fires",
  {
    gaps: Schema.Array(Int(1, 120)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(40)
    ),
  },
  ({ gaps }) =>
    Effect.gen(function* warnOnly() {
      const { pages, ports, sent } = recorder();
      let at = T0;

      yield* runTicks(
        emptyJournal,
        gaps.map((gap) => {
          at += gap * MINUTE;

          return { at, facts: down(healthy, ["instance-b"]) };
        }),
        ports
      );

      expect(
        sent.some((item) => item.text.includes("instance.down warn"))
      ).toBe(true);
      expect(pages).toEqual([]);
    })
);

it.effect.prop(
  "a critical that clears inside five minutes never pages",
  { seconds: Int(60, 299) },
  ({ seconds }) =>
    Effect.gen(function* brief() {
      const { pages, ports, sent } = recorder();
      const samples = Math.floor(seconds / 30);

      yield* runTicks(
        emptyJournal,
        [
          ...Array.from({ length: samples + 1 }, (_, index) => ({
            at: T0 + index * 30_000,
            facts: mailbox(503),
          })),
          { at: T0 + seconds * 1000 + 1000, facts: mailbox(200) },
        ],
        ports
      );

      expect(
        sent.some((item) => item.text.includes("celld.down critical"))
      ).toBe(true);
      expect(pages).toEqual([]);
    })
);

it.effect.prop(
  "a confirmed undeclared critical pages once with its incident id, then pages its clear",
  { length: Int(12, 400) },
  ({ length }) =>
    Effect.gen(function* confirmed() {
      const { pages, ports } = recorder();

      const journal = yield* runTicks(
        emptyJournal,
        [
          ...Array.from({ length }, (_, index) => ({
            at: T0 + index * MINUTE,
            facts: mailbox(503),
          })),
          { at: T0 + length * MINUTE, facts: mailbox(200) },
        ],
        ports
      );

      const incident = T0 + MINUTE;

      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain("celld.down critical");
      expect(pages[0]).toContain(`Incident ${incident}`);
      expect(pages[1]).toBe(
        `✅ cleared celld.down ${incident} after ${(length - 1) * 60} seconds. SR 🐀`
      );
      expect(
        journal.pages.filter((page) => page.incident === incident)
      ).toHaveLength(2);
    })
);

it.effect.prop(
  "a critical inside a declared window never pages",
  { length: Int(12, 600) },
  ({ length }) =>
    Effect.gen(function* declared() {
      const { pages, ports, sent } = recorder();

      const facts: typeof AlarmFacts.Type = {
        ...down(mailbox(503), ["instance-a"]),
        maintenance: [MAILBOX_INSTANCE, "instance-a"].map((instance) => ({
          graceMinutes: 5,
          instance,
          owner: "desk-a",
          reason: "planned restart",
          start: T0,
          until: T0 + length * MINUTE,
        })),
      };

      yield* runTicks(
        emptyJournal,
        Array.from({ length }, (_, index) => ({
          at: T0 + index * MINUTE,
          facts,
        })),
        ports
      );

      expect(pages).toEqual([]);
      expect(sent.every((item) => item.recipients.join(",") === "desk-a")).toBe(
        true
      );
    })
);

const stalled = (age: number, at: number) => ({
  health: {
    complete: true,
    lastAck: null,
    lease: {
      expiresAt: at + MINUTE,
      generation: 1,
      holder: "fixture",
      pane: null,
    },
    oldestWake: { at: at - age, id: "3m7x2ka4xv22a", sender: "sender-invalid" },
    quietUnacked: 0,
  },
  name: "switchboard",
  owner: "board-owner",
});

it.effect.prop(
  "a stalled switchboard stays warn until 30 minutes unacked, then pages once",
  { from: Int(16, 20) },
  ({ from }) =>
    Effect.gen(function* promotion() {
      const { pages, ports } = recorder();
      const born = T0 - from * MINUTE;

      const tick = (minute: number) => {
        const at = born + minute * MINUTE;

        return {
          at,
          facts: { ...healthy, wakes: [stalled(at - born, at)] },
        };
      };

      const young = yield* runTicks(
        emptyJournal,
        Array.from({ length: 30 - from }, (_, index) => tick(from + index)),
        ports
      );

      expect(young.alarms["wake.unacked"]?.value).toBe("firing");
      expect(pages).toEqual([]);

      yield* runTicks(young, [tick(31), tick(32), tick(45)], ports);

      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain("wake.unacked critical");
    })
);
