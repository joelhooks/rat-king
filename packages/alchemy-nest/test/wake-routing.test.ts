import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import { AlarmRefused } from "../../../stacks/nest/alarm-refusal.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { wakeReading } from "../../../stacks/nest/alarm-wakes.ts";
import { alarmCycle, emptyJournal } from "../../../stacks/nest/alarm.ts";
import type {
  AlarmJournalValue,
  AlarmPorts,
} from "../../../stacks/nest/alarm.ts";
import * as Defs from "../../lexicon/src/defs.ts";

const settings = Schema.decodeUnknownSync(AlarmSettings)({
  broadcast: "observer-invalid",
  enabled: false,
  launchd: {
    errorLog: "/fixture.invalid/err",
    label: "alarm.invalid",
    node: "node",
    outputLog: "/fixture.invalid/out",
    path: "/fixture.invalid/bin",
    source: "/fixture.invalid",
  },
  musterDesk: "desk-invalid",
  notify: {
    directory: "/fixture.invalid/directory.json",
    secret: "operator.invalid",
  },
  owners: {},
  page: { node: "node", script: "/fixture.invalid/page.mjs" },
});

const now = 10_000_000;

const health = (oldestAge: number, lastAck: number | null) => ({
  complete: true,
  lastAck,
  lease: {
    expiresAt: now + 60_000,
    generation: 1,
    holder: "fixture",
    pane: null,
  },
  oldestWake: { at: now - oldestAge, id: "private-id", sender: "private-from" },
  quietUnacked: 0,
});

const facts = (owners: readonly string[]): typeof AlarmFacts.Type => ({
  cacheBreaches: [],
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
  wakes: owners.map((owner) => ({
    health: health(1_200_000, null),
    name: `reader-for-${owner}`,
    owner,
  })),
});

const run = (
  owners: readonly string[],
  refusals: Readonly<Record<string, AlarmRefused>>,
  journal: AlarmJournalValue = emptyJournal
) =>
  Effect.gen(function* routed() {
    const template = yield* Schema.decodeUnknownEffect(Defs.EncryptedEnvelope)({
      aad: {
        messageId: "2222222222222",
        recipientDid: "did:web:observer.invalid",
        recipientKeyId: "did:web:observer.invalid#encryption",
        senderDid: "did:web:operator.invalid",
      },
      ciphertext: { $bytes: "AQ==" },
      enc: { $bytes: "AQ==" },
      suite: { aeadId: 0, kdfId: 0, kemId: 0 },
      version: 1,
    });

    const accepted: string[] = [];
    const prepared: (readonly string[])[] = [];
    let unavailable = 0;

    const ports: AlarmPorts<never> = {
      page: () => Effect.void,
      prepare: (key, recipients, text) =>
        Effect.sync(() => {
          prepared.push(recipients);

          return recipients.map((recipient) => ({
            envelope: template,
            key,
            recipient,
            text,
          }));
        }),
      save: () => Effect.void,
      send: (delivery) => {
        const refusal = refusals[delivery.recipient];

        if (refusal !== undefined) {
          return Effect.fail(refusal);
        }

        return Effect.sync(() => {
          accepted.push(delivery.recipient);
        });
      },
      unavailable: Effect.sync(() => {
        unavailable += 1;
      }),
    };

    const after = yield* alarmCycle(
      journal,
      facts(owners),
      now,
      settings,
      ports
    );

    return { accepted, after, prepared, unavailable: () => unavailable };
  });

it.effect(
  "a retired owner is dropped while the live owner and static recipients are still sent, and the cycle stays ok",
  () =>
    Effect.gen(function* retiredAndLive() {
      const result = yield* run(["live-owner", "retired-owner"], {
        "retired-owner": new AlarmRefused({ code: "Retired" }),
      });

      expect(result.accepted.toSorted()).toEqual([
        "desk-invalid",
        "live-owner",
        "observer-invalid",
      ]);
      expect(result.unavailable()).toBe(0);
      expect(result.after.pending).toEqual([]);
    })
);

it.effect(
  "when every owner is retired the fallback desk and broadcast still receive the alarm",
  () =>
    Effect.gen(function* allRetired() {
      const result = yield* run(["gone-a", "gone-b"], {
        "gone-a": new AlarmRefused({ code: "Retired" }),
        "gone-b": new AlarmRefused({ code: "UnknownName" }),
      });

      expect(result.accepted.toSorted()).toEqual([
        "desk-invalid",
        "observer-invalid",
      ]);
      expect(result.unavailable()).toBe(0);
    })
);

it.effect(
  "a retired owner naming a successor is re-sent to the successor on the next cycle",
  () =>
    Effect.gen(function* successor() {
      const first = yield* run(["old-owner"], {
        "old-owner": new AlarmRefused({
          code: "Retired",
          successor: "new-owner",
        }),
      });

      expect(first.prepared.at(-1)).toEqual(["new-owner"]);
      expect(first.after.pending.map((item) => item.recipient)).toEqual([
        "new-owner",
      ]);

      const second = yield* run([], {}, first.after);

      expect(second.accepted).toContain("new-owner");
      expect(second.after.pending).toEqual([]);
      expect(first.unavailable()).toBe(0);
    })
);

const Minutes = Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 0 }));

it.prop(
  "wake.unacked fires only when the oldest wake is overdue and the name has not acked since it or recently",
  [Minutes, Minutes, Schema.Boolean],
  ([waiting, sinceAck, acked]) => {
    const age = waiting * 60_000;
    const lastAck = acked ? now - sinceAck * 60_000 : null;

    const progressing =
      lastAck !== null && lastAck >= now - age && now - lastAck <= 900_000;

    const reading = wakeReading(
      [{ health: health(age, lastAck), name: "reader", owner: "owner" }],
      now
    );

    const firing = age > 900_000 && !progressing;

    expect(reading.status).toBe(firing ? "firing" : "ok");

    if (reading.status === "firing") {
      expect(reading.evidence).not.toContain("private-id");
    }
  }
);

it.effect(
  "stale single messages on acking readers are an info count, not firing",
  () =>
    Effect.sync(() => {
      const reading = wakeReading(
        [
          {
            health: health(1_200_000, now - 30_000),
            name: "acker",
            owner: "a",
          },
          { health: health(1_200_000, null), name: "dead", owner: "b" },
        ],
        now
      );

      expect(reading.status).toBe("firing");

      if (reading.status === "firing") {
        expect(reading.recipients).toEqual(["b"]);
        expect(reading.evidence).toContain("dead:");
        expect(reading.evidence).not.toContain("acker:");
        expect(reading.evidence).toContain("info: 1 stale single message(s)");
      }
    })
);
