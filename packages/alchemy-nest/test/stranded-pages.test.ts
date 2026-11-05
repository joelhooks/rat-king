import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  STRANDED_MAIL_MS,
  strandedReading,
} from "../../../stacks/nest/alarm-stranded.ts";
import { emptyJournal } from "../../../stacks/nest/alarm.ts";
import { healthy, recorder, runTicks } from "./maintenance-fixtures.ts";

const at = 1_800_000_000_000;

const sightings = (now: number, restored = false) =>
  ["reader-a", "reader-b"].map((name) => ({
    alive: restored,
    health: {
      complete: true,
      lastAck: null,
      lease: {
        expiresAt: now + 60_000,
        generation: 1,
        holder: "session-invalid",
        pane: null,
      },
      oldestWake: {
        at: at - STRANDED_MAIL_MS - 1,
        id: "fixture-id",
        sender: "sender-invalid",
      },
      quietUnacked: 0,
    },
    lastTurnAt: now,
    name,
    owner: "reader-owner",
  }));

it.effect.prop(
  "old mail on dead readers pages once per reader and clears on drain or return",
  {
    drained: Schema.Boolean,
    repeats: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 2 })),
  },
  ({ drained, repeats }) =>
    Effect.gen(function* pagesPerReader() {
      const { ports, pages, sent } = recorder();

      const ticks = Array.from({ length: repeats }, (_, index) => {
        const now = at + index * 11 * 60_000;

        return { at: now, facts: { ...healthy, wakes: sightings(now) } };
      });

      const journal = yield* runTicks(emptyJournal, ticks, ports);
      expect(pages).toHaveLength(2);
      const now = at + repeats * 11 * 60_000;

      const wakes = sightings(now, true).map((item) =>
        drained
          ? { ...item, health: { ...item.health, oldestWake: null } }
          : item
      );

      const recovered = yield* runTicks(
        journal,
        [{ at: now, facts: { ...healthy, wakes } }],
        ports
      );

      expect(pages).toHaveLength(4);

      for (const name of ["reader-a", "reader-b"]) {
        expect(recovered.alarms[`mail.stranded/${name}`]?.value).toBe(
          "recovered"
        );
        expect(
          sent.find(
            (notice) =>
              notice.key === `mail.stranded/${name}` &&
              notice.text.startsWith("✅")
          )?.recipients
        ).toContain("reader-owner");
      }
    })
);

it.prop(
  "live leases page only with observed old turn activity, not missing turn evidence",
  {
    minutes: Schema.Int.check(Schema.isBetween({ maximum: 480, minimum: 0 })),
  },
  ({ minutes }) => {
    const [item] = sightings(at, true);

    if (item === undefined) {
      throw new Error("missing fixture");
    }

    expect(
      strandedReading({ ...item, lastTurnAt: at - minutes * 60_000 }, at).status
    ).toBe(minutes > 240 ? "firing" : "ok");
    expect(
      strandedReading(
        {
          alive: true,
          health: item.health,
          name: item.name,
          owner: item.owner,
        },
        at
      ).status
    ).toBe("ok");
    expect(
      strandedReading({ ...item, alive: false, session: "previous-holder" }, at)
        .status
    ).toBe("unknown");
  }
);

it.effect.prop(
  "configured waits notify only their owner, without broadcasting or paging",
  {
    minutes: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 16 })),
  },
  ({ minutes }) =>
    Effect.gen(function* ownerOptIn() {
      const { ports, pages, sent } = recorder();

      const wakes = sightings(at, true).map((item) => ({
        ...item,
        configured: true as const,
        health: {
          ...item.health,
          oldestWake: {
            at: at - minutes * 60_000,
            id: "fixture-id",
            sender: "sender-invalid",
          },
        },
        page: true,
        unackedMinutes: 15,
      }));

      yield* runTicks(
        emptyJournal,
        [{ at, facts: { ...healthy, wakes } }],
        ports
      );
      expect(pages).toEqual([]);
      expect(sent).toHaveLength(2);
      expect(
        sent.every(
          (notice) =>
            notice.key.startsWith("mail.owner/") &&
            notice.recipients.join(",") === "reader-owner"
        )
      ).toBe(true);
    })
);
