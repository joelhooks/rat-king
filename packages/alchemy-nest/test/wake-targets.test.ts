import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  mergeWakeTargets,
  wakeReading,
} from "../../../stacks/nest/alarm-wakes.ts";

const target = {
  name: "mischief/worker",
  owner: "pi-durable/desk",
};

const Minutes = Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 1 }));

it.prop(
  "configured targets fire strictly past their threshold for live, expired and missing leases; heartbeat-only expiry stays unknown",
  [Minutes],
  ([minutes]) => {
    const now = 10_000_000;

    for (const threshold of [undefined, minutes, 15]) {
      const targets =
        mergeWakeTargets(undefined, [
          threshold === undefined
            ? target
            : { ...target, unackedMinutes: threshold },
        ]) ?? [];

      const limit = (threshold ?? 15) * 60_000;

      for (const expiresAt of [null, now - 1, now, now + 1]) {
        for (const age of [limit - 1, limit, limit + 1]) {
          const health = {
            complete: true,
            lastAck: null,
            lease:
              expiresAt === null
                ? null
                : { expiresAt, generation: 1, holder: "fixture", pane: null },
            oldestWake: {
              at: now - age,
              id: "private-message-invalid",
              sender: "private-sender-invalid",
            },
            quietUnacked: 0,
          };

          const reading = wakeReading(
            targets.map((entry) => ({ ...entry, health })),
            now
          );

          expect(reading.status).toBe(age > limit ? "firing" : "ok");

          if (reading.status === "firing") {
            expect(reading.recipients).toEqual([target.owner]);
            expect(reading.evidence).toContain(target.name);
            expect(reading.evidence).toContain(`${Math.floor(age / 1000)}s`);
            expect(reading.evidence).toContain(
              expiresAt === null || expiresAt <= now
                ? "reader gone"
                : "live lease"
            );

            if (expiresAt === null) {
              expect(reading.evidence).toContain("lease missing");
            } else {
              expect(reading.evidence).toContain(
                expiresAt <= now ? "lease expired" : "live lease"
              );
            }

            expect(reading.evidence).not.toContain(health.oldestWake.id);
            expect(reading.evidence).not.toContain(health.oldestWake.sender);
          }

          expect(
            wakeReading(
              targets.map((entry) => ({
                ...entry,
                health: { ...health, oldestWake: null },
              })),
              now
            ).status
          ).toBe("ok");
          const liveStatus = age > 900_000 ? "firing" : "ok";

          expect(wakeReading([{ ...target, health }], now).status).toBe(
            expiresAt === null || expiresAt <= now ? "unknown" : liveStatus
          );
        }
      }
    }
  }
);

it.prop(
  "configured names override duplicate heartbeat owners, paging and thresholds without duplicating queries",
  [
    Schema.Struct({
      page: Schema.optionalKey(Schema.Boolean),
      unackedMinutes: Minutes,
    }),
  ],
  ([input]) => {
    const configured = { ...target, ...input };

    for (const readers of [
      undefined,
      [],
      [target],
      [
        { ...target, owner: "heartbeat/desk", page: true, unackedMinutes: 1 },
        target,
      ],
    ]) {
      const merged = mergeWakeTargets(readers, [configured]);

      expect(merged).toEqual([{ ...configured, configured: true }]);
    }

    expect(mergeWakeTargets()).toBeUndefined();
    expect(mergeWakeTargets([target])).toEqual([target]);
  }
);

it.prop(
  "alarm wake target decoding accepts positive thresholds and rejects unknown fields and non-positive thresholds",
  [Minutes],
  ([unackedMinutes]) => {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({ wakeTargets: AlarmSettings.fields.wakeTargets }),
      { onExcessProperty: "error" }
    );

    const configured = { ...target, unackedMinutes };

    expect(decode({ wakeTargets: [configured] }).wakeTargets).toEqual([
      configured,
    ]);
    expect(decode({ wakeTargets: [target] }).wakeTargets).toEqual([target]);

    for (const page of [false, true]) {
      expect(
        decode({ wakeTargets: [{ ...configured, page }] }).wakeTargets
      ).toEqual([{ ...configured, page }]);
    }

    expect(() =>
      decode({ wakeTargets: [{ ...configured, unknown: true }] })
    ).toThrow();

    expect(() =>
      decode({ wakeTargets: [{ ...configured, page: "true" }] })
    ).toThrow();

    for (const invalid of [0, -unackedMinutes, Number.POSITIVE_INFINITY]) {
      expect(() =>
        decode({ wakeTargets: [{ ...configured, unackedMinutes: invalid }] })
      ).toThrow();
    }
  }
);

const sinceAck = (
  oldestAge: number,
  lastAckAge: number | null,
  waitingAge: number | null
) => ({
  complete: true,
  lastAck: lastAckAge === null ? null : 10_000_000 - lastAckAge,
  lease: {
    expiresAt: 10_000_000 + 60_000,
    generation: 1,
    holder: "fixture",
    pane: null,
  },
  oldestWake: {
    at: 10_000_000 - oldestAge,
    id: "id-invalid",
    sender: "s-invalid",
  },
  oldestWakeSinceAck:
    waitingAge === null
      ? null
      : { at: 10_000_000 - waitingAge, id: "id-invalid", sender: "s-invalid" },
  quietUnacked: 0,
});

it("an idle reader whose only unacked mail predates its last ack does not fire, and shows as info", () => {
  const now = 10_000_000;
  const hours = 7_200_000;

  for (const configured of [true, false]) {
    const entry = configured
      ? { ...target, configured: true as const }
      : target;

    const reading = wakeReading(
      [{ ...entry, health: sinceAck(3 * hours, 2.5 * hours, null) }],
      now
    );

    expect(reading.status).toBe("ok");
  }
});

it("a reader that acked and then died with newer mail waiting fires", () => {
  const now = 10_000_000;

  for (const configured of [true, false]) {
    const entry = configured
      ? { ...target, configured: true as const }
      : target;

    const reading = wakeReading(
      [{ ...entry, health: sinceAck(7_200_000, 3_600_000, 1_200_000) }],
      now
    );

    expect(reading.status).toBe("firing");

    if (reading.status === "firing") {
      expect(reading.evidence).toContain("mail waiting 1200s");
    }
  }
});

it("a reader that never acked fires on overdue mail", () => {
  const now = 10_000_000;

  const reading = wakeReading(
    [
      {
        ...target,
        configured: true,
        health: sinceAck(1_200_000, null, 1_200_000),
      },
    ],
    now
  );

  expect(reading.status).toBe("firing");
});

const unackedFor = (minutes: number) => ({
  complete: true,
  lastAck: null,
  lease: {
    expiresAt: 10_000_000 + 60_000,
    generation: 1,
    holder: "fixture",
    pane: null,
  },
  oldestWake: {
    at: 10_000_000 - minutes * 60_000,
    id: "id-invalid",
    sender: "s-invalid",
  },
  quietUnacked: 0,
});

it("an unconfigured live reader fires only past 15 minutes by default", () => {
  const now = 10_000_000;

  expect(wakeReading([{ ...target, health: unackedFor(4) }], now).status).toBe(
    "ok"
  );
  expect(wakeReading([{ ...target, health: unackedFor(16) }], now).status).toBe(
    "firing"
  );
});

it("alarm.wakeUnackedMinutes sets the default threshold", () => {
  const now = 10_000_000;

  const sighting = {
    ...target,
    defaultUnackedMinutes: 5,
    health: unackedFor(6),
  };

  expect(wakeReading([sighting], now).status).toBe("firing");
  expect(
    wakeReading([{ ...sighting, health: unackedFor(4) }], now).status
  ).toBe("ok");
});

it("a configured target's unackedMinutes beats the default", () => {
  const now = 10_000_000;

  const sighting = {
    ...target,
    configured: true as const,
    defaultUnackedMinutes: 30,
    health: unackedFor(2),
    unackedMinutes: 1,
  };

  expect(wakeReading([sighting], now).status).toBe("firing");
});
