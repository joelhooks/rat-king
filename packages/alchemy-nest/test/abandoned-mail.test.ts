import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  abandonedMailLines,
  strandedReading,
} from "../../../stacks/nest/alarm-stranded.ts";
import type { WakeSighting } from "../../../stacks/nest/alarm-wakes.ts";
import {
  AlarmJournal,
  alarmCycle,
  emptyJournal,
} from "../../../stacks/nest/alarm.ts";
import { healthy, recorder, settings } from "./maintenance-fixtures.ts";

const now = 1_800_000_000_000;

const hour = 3_600_000;

const names = [
  "closed-row",
  "proof-session",
  "one-off-session",
  "closed-desk",
  "bridge-owner",
  "service-owner",
];

const mailbox = (name: string, age: number): typeof WakeSighting.Type => ({
  health: {
    complete: true,
    lastAck: null,
    lease: {
      expiresAt: now - 25 * hour,
      generation: 1,
      holder: "session-invalid",
      pane: null,
    },
    oldestWake: {
      at: now - age * hour,
      id: "fixture-id",
      sender: "sender-invalid",
    },
    quietUnacked: 0,
  },
  name,
  owner: "owner-invalid",
});

it.effect.prop(
  "four retired mailboxes and two stale dead-pid heartbeats stay silent even with old critical outbox entries",
  {
    hours: Schema.Int.check(Schema.isBetween({ maximum: 240, minimum: 25 })),
    unknownFirst: Schema.Boolean,
  },
  ({ hours, unknownFirst }) =>
    Effect.gen(function* silent() {
      const seen = names.map((name, index) => ({
        ...mailbox(name, hours),
        ...(index < 4
          ? {
              alive: true,
              lastProgressAt: now,
              lastTurnAt: now - 8 * hour,
              retired: true,
            }
          : { alive: false, lastProgressAt: now - 48 * hour, retired: false }),
      }));

      const alarms = Object.fromEntries(
        names.map((name) => [
          `mail.stranded/${name}`,
          {
            context: {
              lastSent: now - hour,
              severity: unknownFirst ? "warn" : "critical",
              since: now - hour,
            },
            value: "firing",
          },
        ])
      );

      const journal = yield* Schema.decodeUnknownEffect(AlarmJournal)({
        ...emptyJournal,
        alarms,
        notices: names.map((name) => ({
          incident: now - hour,
          key: `mail.stranded/${name}`,
          kind: "fire",
          recipients: ["owner-invalid"],
          text: "obsolete critical",
        })),
        pages: names.map((name) => ({
          at: now - hour,
          incident: now - hour,
          key: `mail.stranded/${name}`,
        })),
        pending: names.map((name) => ({
          envelope: {
            aad: {
              messageId: "2222222222222",
              recipientDid: "did:web:recipient.invalid",
              recipientKeyId: "did:web:recipient.invalid#encryption",
              senderDid: "did:web:sender.invalid",
            },
            ciphertext: { $bytes: "AQ==" },
            enc: { $bytes: "AQ==" },
            suite: { aeadId: 0, kdfId: 0, kemId: 0 },
            version: 1,
          },
          key: `mail.stranded/${name}`,
          recipient: "owner-invalid",
          text: "obsolete critical",
        })),
      });

      const { ports, pages, sent } = recorder();

      const waiting = unknownFirst
        ? yield* alarmCycle(
            journal,
            { ...healthy, wakes: null },
            now,
            settings,
            {
              ...ports,
              send: () => Effect.die("unverified retirement outbox was sent"),
            }
          )
        : journal;

      if (unknownFirst) {
        expect(waiting.pending).toHaveLength(6);
        expect(waiting.notices).toHaveLength(6);
      }

      const result = yield* alarmCycle(
        waiting,
        { ...healthy, wakes: seen },
        now,
        settings,
        { ...ports, send: () => Effect.die("abandoned outbox was sent") }
      );

      expect(pages).toEqual([]);
      expect(sent).toEqual([]);
      expect(result.pending).toEqual([]);
      expect(result.pages).toEqual([]);
      expect(abandonedMailLines(seen, now)).toEqual([
        `abandoned mailboxes: 2 (oldest ${hours}h)`,
      ]);
    })
);

it.prop(
  "dead heartbeat wake authority ends strictly at 24h; recent leases without a heartbeat never wake",
  {
    minutes: Schema.Int.check(Schema.isBetween({ maximum: 2880, minimum: 0 })),
  },
  ({ minutes }) => {
    const item = mailbox("reader-invalid", 8);
    expect(
      strandedReading(
        {
          ...item,
          alive: false,
          lastProgressAt: now - minutes * 60_000,
          retired: false,
        },
        now
      )
    ).toMatchObject(
      minutes < 1440 ? { severity: "warn", status: "firing" } : { status: "ok" }
    );

    const leased = {
      ...item,
      health:
        item.health === null
          ? null
          : {
              ...item.health,
              lease: {
                expiresAt: now + hour,
                generation: 1,
                holder: "session-invalid",
                pane: null,
              },
            },
      lastTurnAt: now - 8 * hour,
      retired: false,
    };

    expect(strandedReading(leased, now).status).toBe("ok");
    expect(
      strandedReading(
        { ...item, alive: false, lastProgressAt: now, retired: null },
        now
      ).status
    ).toBe("unknown");
    expect(
      strandedReading({ ...leased, alive: true, retired: true }, now).status
    ).toBe("ok");
  }
);
