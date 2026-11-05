import { it } from "@effect/vitest";
import type * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import { Transport } from "@rat-king/lexicon/transport";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { readTurnHealth } from "../../../packages/mailbox-client/src/turn-health.ts";

const Inputs = Schema.Struct({
  encrypted: Schema.Boolean,
  spoof: Schema.Boolean,
  startsOnly: Schema.Boolean,
  wrapped: Schema.Boolean,
});

it.effect.prop(
  "turn health projects only the named sender's visible current-session record, raw or wrapped; encrypted records stay unknown",
  [Inputs],
  ([input]) =>
    Effect.gen(function* turn() {
      const record = {
        $type: "sh.mschf.agentgraph.turn",
        agent: "sample/worker",
        at: "2026-10-11T00:00:00.000Z",
        session: "session",
        state: "working",
        turnId: "session:1",
        version: "0.1",
      };

      const text = JSON.stringify(record);

      const body = input.wrapped
        ? JSON.stringify({ body: text, from: "sample/worker", kind: "data" })
        : text;

      const entry: typeof Traffic.Entry.Encoded = {
        ciphertextSize: 10,
        messageId: "3m7x2ka4xv22a",
        recipientDid: "did:web:owner.example.invalid",
        recipientSeq: 1,
        senderDid: input.spoof
          ? "did:web:other.example.invalid"
          : "did:web:worker.example.invalid",
        seq: 1,
        state: "acked",
        time: record.at,
      };

      if (!input.encrypted) {
        Object.assign(entry, { body });
      }

      const completed = {
        ...record,
        at: "2026-10-11T01:00:00.000Z",
        state: "done",
      };

      const completionText = JSON.stringify(completed);

      const completionBody = input.wrapped
        ? JSON.stringify({
            body: completionText,
            from: "sample/worker",
            kind: "data",
          })
        : completionText;

      const completion = {
        ...entry,
        recipientSeq: 2,
        seq: 2,
        ...(input.encrypted ? undefined : { body: completionBody }),
      };

      const transport = Transport.of({
        request: () =>
          Effect.succeed({
            body: { cursor: "2", events: [entry, completion] },
            kind: "json",
            status: 200,
          }),
      });

      const result = yield* readTurnHealth(
        transport,
        "did:web:worker.example.invalid",
        "sample/worker",
        "session",
        input.startsOnly
      );

      if (input.encrypted || input.spoof) {
        expect(result).toBeNull();
      } else {
        expect(result).toEqual({
          at: input.startsOnly ? record.at : completed.at,
          state: input.startsOnly ? "working" : "done",
          turnId: "session:1",
        });
      }
    })
);
