import { it } from "@effect/vitest";
import { seal } from "@rat-king/envelope";
import { Arbitrary, Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import {
  payload,
  recipientDid,
  senderDid,
  testKeys,
} from "../../envelope/test/helpers.ts";
import {
  AgentJournal,
  AgentKeys,
  AgentMailbox,
  drainMailbox,
} from "../src/mailbox-loop.ts";
import type { JournalValue } from "../src/mailbox-loop.ts";
import { AgentHarness, Settlement, SubmissionId } from "../src/port.ts";

const Poison = Schema.Literals(["invalid-body", "invalid-seal"]);

const ids = ["3m7x2ka4xv22a", "3m7x2ka4xv22b", "3m7x2ka4xv22c"];

it.effect.prop(
  "a bad envelope is terminally recorded and both adjacent inputs still get replies",
  [Arbitrary.schema(Poison)],
  ([poison]) =>
    Effect.gen(function* proof() {
      const keys = yield* testKeys();
      const journal = new Map<string, JournalValue>();
      const failures: string[] = [];
      const acknowledged: string[] = [];
      const submitted: string[] = [];
      const replies: string[] = [];

      const envelopes = yield* Effect.forEach(
        ids.map((id, index) => ({ id, index })),
        Effect.fnUntraced(function* envelope({ id, index }) {
          const input = payload(id);

          const sealed = yield* seal({
            payload: {
              ...input,
              body:
                index === 1 && poison === "invalid-body"
                  ? Uint8Array.of(255)
                  : new TextEncoder().encode(`input-${index}`),
            },
            recipientKey: keys.recipient.publicKey,
            recipientKeyId: `${recipientDid}#encryption`,
            signingKey: keys.sender.privateKey,
            signingKeyId: `${senderDid}#atproto`,
          });

          return index === 1 && poison === "invalid-seal"
            ? { ...sealed, ciphertext: Uint8Array.of(0) }
            : sealed;
        })
      );

      yield* drainMailbox().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(AgentJournal, {
              read: (id) => Effect.sync(() => journal.get(id)),
              replyId: () => Effect.succeed("3m7x2ka4xv22d"),
              write: (id, value) =>
                Effect.sync(() => {
                  journal.set(id, value);
                }),
            }),
            Layer.succeed(AgentKeys, {
              agreement: keys.recipient.privateKey,
              did: recipientDid,
              resolve: (_did, _keyId, purpose) =>
                Effect.succeed(
                  purpose === "authentication"
                    ? keys.sender.publicKey
                    : keys.recipient.publicKey
                ),
              signing: keys.sender.privateKey,
            }),
            Layer.succeed(AgentMailbox, {
              ack: (message) =>
                Effect.sync(() => {
                  acknowledged.push(message.messageId);
                }),
              fail: (message) =>
                Effect.sync(() => {
                  failures.push(message.messageId);
                }),
              inject: () => Effect.void,
              pending: () => Effect.succeed(envelopes),
              send: (envelope) =>
                Effect.sync(() => {
                  replies.push(envelope.aad.recipientDid);
                }),
            }),
            Layer.succeed(AgentHarness, {
              resume: () => Effect.void,
              submit: ({ content }) =>
                Effect.sync(() => {
                  submitted.push(content);

                  return SubmissionId.make(submitted.length);
                }),
              wait: (id) =>
                Effect.succeed(
                  Settlement.cases.Done.make({ answer: "reply", id })
                ),
            })
          )
        )
      );

      expect(submitted).toEqual(["input-0", "input-2"]);
      expect(replies).toEqual([senderDid, senderDid]);
      expect(acknowledged).toEqual([ids[0], ids[2]]);
      expect(failures).toEqual([ids[1]]);
      expect([...journal.values()].map((entry) => entry._tag)).toEqual([
        "acked",
        "failed",
        "acked",
      ]);
    })
);
