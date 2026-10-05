import { open, seal, suite } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { Context, Effect, Match, Schema } from "effect";
import { createMachine, transition } from "xstate";

import { AgentJournal, Journal } from "./agent-journal.ts";
import type { JournalValue } from "./agent-journal.ts";
import { AgentKeys } from "./agent-keys.ts";
import { AgentHarness, HarnessFailure, RequestId, Settlement } from "./port.ts";

export { AgentJournal, Journal } from "./agent-journal.ts";

export type { JournalValue } from "./agent-journal.ts";

export { AgentKeys } from "./agent-keys.ts";

export type { LoopKeys } from "./agent-keys.ts";

export const loopLifecycle = createMachine({
  context: {},
  id: "mailbox-loop",
  initial: "pending",
  states: {
    acked: { type: "final" },
    answered: { on: { sealed: { target: "sealed" } } },
    failed: { type: "final" },
    pending: { on: { submitted: { target: "submitted" } } },
    replied: { on: { acked: { target: "acked" } } },
    sealed: { on: { replied: { target: "replied" } } },
    submitted: {
      on: {
        answered: { target: "answered" },
        unanswered: { target: "unanswered" },
      },
    },
    unanswered: { on: { failed: { target: "failed" } } },
  },
});

export interface LoopMailbox {
  readonly ack: (
    message: Defs.MessageRefValue
  ) => Effect.Effect<void, HarnessFailure>;
  readonly fail: (
    message: Defs.MessageRefValue,
    reason: string
  ) => Effect.Effect<void, HarnessFailure>;
  readonly inject: (
    message: Defs.MessageRefValue
  ) => Effect.Effect<void, HarnessFailure>;
  readonly pending: () => Effect.Effect<
    readonly Defs.EncryptedEnvelopeValue[],
    HarnessFailure
  >;
  readonly send: (
    envelope: Defs.EncryptedEnvelopeValue
  ) => Effect.Effect<void, HarnessFailure>;
}

export class AgentMailbox extends Context.Service<AgentMailbox, LoopMailbox>()(
  "@rat-king/AgentMailbox"
) {}

export const drainMailbox = Effect.fn("Agent.drainMailbox")(
  function* drainMailbox() {
    const mailbox = yield* AgentMailbox;
    const journal = yield* AgentJournal;
    const keys = yield* AgentKeys;
    const harness = yield* AgentHarness;

    yield* harness.resume();

    for (const envelope of yield* mailbox.pending()) {
      const message = yield* Schema.decodeUnknownEffect(Defs.MessageRef)({
        messageId: envelope.aad.messageId,
        senderDid: envelope.aad.senderDid,
      });

      const requestId = yield* Schema.decodeEffect(RequestId)(
        `${message.senderDid}/${message.messageId}`
      );

      const stored = yield* journal.read(requestId);

      let current: JournalValue =
        stored ??
        Journal.cases.pending.make({ replyId: yield* journal.replyId() });

      if (stored === undefined) {
        yield* journal.write(requestId, current);
      }

      const save = Effect.fn("Agent.checkpoint")(function* save(
        next: JournalValue
      ) {
        const [snapshot] = transition(
          loopLifecycle,
          loopLifecycle.resolveState({ context: {}, value: current._tag }),
          { type: next._tag }
        );

        if (snapshot.value !== next._tag) {
          return yield* new HarnessFailure({
            operation: "checkpoint",
            reason: "Invalid loop transition",
          });
        }

        yield* journal.write(requestId, next);
        current = next;

        return yield* Effect.void;
      });

      const step = (checkpoint: JournalValue) =>
        Match.value(checkpoint).pipe(
          Match.tagsExhaustive({
            acked: () => Effect.void,
            answered: (state) =>
              Effect.gen(function* sealReply() {
                const payload = yield* Schema.decodeUnknownEffect(
                  Schema.toType(Defs.SigningPayload)
                )({
                  aad: {
                    messageId: state.replyId,
                    recipientDid: message.senderDid,
                    recipientKeyId: `${message.senderDid}#encryption`,
                    senderDid: keys.did,
                  },
                  body: new TextEncoder().encode(state.answer),
                  replyTo: message,
                  suite,
                  version: 1,
                });

                const reply = yield* seal({
                  payload,
                  recipientKey: yield* keys.resolve(
                    message.senderDid,
                    payload.aad.recipientKeyId,
                    "keyAgreement"
                  ),
                  recipientKeyId: payload.aad.recipientKeyId,
                  signingKey: keys.signing,
                  signingKeyId: `${keys.did}#atproto`,
                });

                yield* save(Journal.cases.sealed.make({ envelope: reply }));
              }),
            failed: () => Effect.void,
            pending: (state) =>
              Effect.gen(function* submitMessage() {
                yield* mailbox.inject(message);

                const payload = yield* open({
                  envelope,
                  recipientDid: keys.did,
                  recipientKey: keys.agreement,
                  recipientKeyId: `${keys.did}#encryption`,
                  resolveSigningKey: (did, keyId) =>
                    keys.resolve(did, keyId, "authentication"),
                });

                const content = new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: false,
                }).decode(payload.body);

                const id = yield* harness.submit({ content, requestId });

                yield* save(
                  Journal.cases.submitted.make({ id, replyId: state.replyId })
                );
              }),
            replied: () =>
              Effect.gen(function* acknowledge() {
                yield* mailbox.ack(message);
                yield* save(Journal.cases.acked.make({}));
              }),
            sealed: (state) =>
              Effect.gen(function* deliverReply() {
                yield* mailbox.send(state.envelope);
                yield* save(Journal.cases.replied.make({}));
              }),
            submitted: (state) =>
              Effect.gen(function* settleSubmission() {
                const settled = yield* harness.wait(state.id);

                yield* save(
                  Settlement.guards.Done(settled)
                    ? Journal.cases.answered.make({
                        answer: settled.answer,
                        replyId: state.replyId,
                      })
                    : Journal.cases.unanswered.make({ reason: settled.reason })
                );
              }),
            unanswered: (state) =>
              Effect.gen(function* failedReceipt() {
                yield* mailbox.fail(
                  message,
                  "Agent harness settled unanswered"
                );
                yield* save(
                  Journal.cases.failed.make({ reason: state.reason })
                );
              }),
          })
        );

      while (
        !Journal.guards.acked(current) &&
        !Journal.guards.failed(current)
      ) {
        yield* step(current);
      }
    }

    return yield* Effect.void;
  }
);
