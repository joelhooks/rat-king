import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";

import { MailboxStore } from "../src/store.ts";
import { appendTraffic, TrafficOutboxEntry } from "../src/traffic-store.ts";
import { lastTurnStart } from "../src/turn-starts.ts";
import { testStoreFor } from "./helpers.ts";

const sender = "did:web:sender.invalid";

const other = "did:web:other.invalid";

const recipient = "did:web:recipient.invalid";

const agent = "fixture/reader";

const session = "current";

const stamp = (n: number) => DateTime.formatIso(DateTime.makeUnsafe(n * 1000));

it.effect.prop(
  "traffic projects the newest working timestamp per DID, name and session, ignoring delivery receipts and terminal turns",
  {
    newer: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 2 })),
  },
  ({ newer }) =>
    Effect.gen(function* testProjection() {
      const storage = yield* testStoreFor(recipient);
      yield* MailboxStore.pipe(Effect.provide(storage.layer));

      const entry = (seq: number, time: number, on = session, by = sender) => ({
        body: JSON.stringify({
          $type: "sh.mschf.agentgraph.turn",
          agent,
          at: stamp(time),
          session: on,
          state: "working",
          turnId: `${on}:${seq}`,
          version: "0.1",
        }),
        ciphertextSize: 3,
        messageId: "2222222222222",
        recipientDid: recipient,
        recipientSeq: seq,
        senderDid: by,
        seq,
        state: "accepted",
        time: stamp(time),
      });

      const terminal = (n: number) => {
        const item = entry(7, n);

        return { ...item, body: item.body.replace('"working"', '"done"') };
      };

      appendTraffic(
        storage.sql,
        yield* Schema.decodeUnknownEffect(Schema.Array(TrafficOutboxEntry))([
          entry(1, newer),
          entry(2, 1),
          entry(3, newer + 1, "old"),
          entry(4, newer + 2, session, other),
          { ...entry(5, newer + 3), state: "acked" },
          terminal(newer + 4),
        ])
      );

      expect(lastTurnStart(storage.sql, sender, agent, session)).toBe(
        stamp(newer)
      );
      expect(
        lastTurnStart(storage.sql, sender, agent, "unknown")
      ).toBeUndefined();
      expect(
        lastTurnStart(storage.sql, sender, "somebody-else", session)
      ).toBeUndefined();
      expect(lastTurnStart(storage.sql, other, agent, session)).toBe(
        stamp(newer + 2)
      );
    })
);
