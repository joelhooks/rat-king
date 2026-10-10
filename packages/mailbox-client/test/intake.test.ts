import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as Lease from "@rat-king/lexicon/runtime.lease";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { expect } from "vitest";

import { sealed, recipientDid } from "../../envelope/test/helpers.ts";
import { consume } from "../src/consume.ts";
import { MailboxClientError } from "../src/error.ts";
import { RatKingMailbox } from "../src/mailbox.ts";
import type { Batch, OpenedMessage } from "../src/mailbox.ts";

it.effect.prop(
  "ack follows durable intake, never failed intake, and finite consumption releases",
  [Arbitrary.schema(Schema.Boolean)],
  ([durable]) =>
    Effect.gen(function* intakeProof() {
      const sample = yield* sealed();
      const now = yield* Clock.currentTimeMillis;

      const lease = yield* Schema.decodeUnknownEffect(Lease.Main)({
        did: recipientDid,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
        generation: 1,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: "intake",
        },
        leaseId: "3mxcx45mn7sex",
      });

      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.Receipt)
      )({
        message: {
          messageId: sample.envelope.aad.messageId,
          senderDid: sample.envelope.aad.senderDid,
        },
        recipientDid,
        seq: 1,
        state: "accepted",
      });

      const event = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.MessageEvent)
      )({
        $type: "sh.mschf.ratking.defs#messageEvent",
        envelope: sample.envelope,
        receipt,
        seq: 1,
      });

      const batch: Batch = {
        events: [{ ...event, $type: "sh.mschf.ratking.defs#messageEvent" }],
        throughSeq: 1,
      };

      const steps: string[] = [];

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            ack: (input) =>
              Effect.sync(() => {
                expect(input.leaseId).toBe(lease.leaseId);
                expect(input.generation).toBe(lease.generation);
                steps.push("ack");

                return { receipt };
              }),
            deliver: () =>
              Effect.sync(() => {
                steps.push("deliver");

                return { receipt };
              }),
            lease: {
              acquire: () => Effect.succeed(lease),
              release: () =>
                Effect.sync(() => {
                  steps.push("release");
                }),
              renew: () => Effect.succeed(lease),
              resolve: () => Effect.succeed(lease),
            },
            open: () =>
              Effect.succeed({
                body: "intake",
                senderDid: sample.envelope.aad.senderDid,
                tid: sample.envelope.aad.messageId,
                verified: true,
              }),
            watch: () => Stream.make(batch),
          })
        )
      );

      const result = yield* consume(
        mailbox,
        recipientDid,
        () =>
          Effect.gen(function* durableIntake() {
            steps.push("intake");

            if (!durable) {
              return yield* Effect.fail("not durable");
            }

            steps.push("durable");

            return yield* Effect.void;
          }),
        { harness: lease.harness }
      ).pipe(Effect.result);

      expect(Result.isSuccess(result)).toBe(durable);
      expect(steps).toEqual(
        durable
          ? ["deliver", "intake", "durable", "ack", "release"]
          : ["deliver", "intake", "release"]
      );
    }).pipe(Effect.scoped)
);

const Outcome = Schema.Literals([
  "opens",
  "recovers",
  "unopenable",
  "settled",
  "ackSettled",
]);

const expectedSteps = (outcome: typeof Outcome.Type, seq: number) =>
  Match.value(outcome).pipe(
    Match.when("unopenable", () => [
      `recover? ${seq}`,
      `skip ${seq} unopenable`,
    ]),
    Match.when("settled", () => ["deliver", `skip ${seq} settled`]),
    Match.when("recovers", () => [
      `recover? ${seq}`,
      "deliver",
      `handle ${seq}`,
      "ack",
    ]),
    Match.orElse(() => ["deliver", `handle ${seq}`, "ack"])
  );

it.effect.prop(
  "unopenable and already settled messages never block later mail: each is skipped and reported, and a recovered one is taken in",
  [
    Arbitrary.schema(
      Schema.Array(Outcome).check(Schema.isMinLength(1), Schema.isMaxLength(6))
    ),
  ],
  ([outcomes]) =>
    Effect.gen(function* skipProof() {
      const sample = yield* sealed();
      const now = yield* Clock.currentTimeMillis;

      const lease = yield* Schema.decodeUnknownEffect(Lease.Main)({
        did: recipientDid,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
        generation: 1,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: "skip",
        },
        leaseId: "3mxcx45mn7sex",
      });

      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.Receipt)
      )({
        message: {
          messageId: sample.envelope.aad.messageId,
          senderDid: sample.envelope.aad.senderDid,
        },
        recipientDid,
        seq: 1,
        state: "accepted",
      });

      const seqs = outcomes.map((_outcome, index) => index + 1);

      const events = yield* Effect.all(
        seqs.map((seq) =>
          Schema.decodeUnknownEffect(Schema.toType(Defs.MessageEvent))({
            $type: "sh.mschf.ratking.defs#messageEvent",
            envelope: sample.envelope,
            receipt: { ...receipt, seq },
            seq,
          })
        )
      );

      const batch: Batch = {
        events: events.map((event) => ({
          ...event,
          $type: "sh.mschf.ratking.defs#messageEvent" as const,
        })),
        throughSeq: outcomes.length,
      };

      const opened = (seq: number): OpenedMessage => ({
        body: `${seq}`,
        senderDid: sample.envelope.aad.senderDid,
        tid: sample.envelope.aad.messageId,
        verified: true,
      });

      const settled = new MailboxClientError({
        error: "InvalidTransition",
        reason: "Mailbox request failed",
      });

      const outcomeAt = (seq: number) => outcomes[seq - 1] ?? "opens";
      const steps: string[] = [];
      let current = 0;

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            ack: () =>
              Effect.suspend(() => {
                steps.push("ack");

                return outcomeAt(current) === "ackSettled"
                  ? Effect.fail(settled)
                  : Effect.succeed({ receipt });
              }),
            deliver: () =>
              Effect.suspend(() => {
                steps.push("deliver");

                return outcomeAt(current) === "settled"
                  ? Effect.fail(settled)
                  : Effect.succeed({ receipt });
              }),
            lease: {
              acquire: () => Effect.succeed(lease),
              release: () => Effect.void,
              renew: () => Effect.succeed(lease),
              resolve: () => Effect.succeed(lease),
            },
            open: () =>
              Effect.suspend(() => {
                current += 1;

                return ["recovers", "unopenable"].includes(outcomeAt(current))
                  ? Effect.fail(
                      new MailboxClientError({
                        reason: "Unauthorized sender signing key",
                      })
                    )
                  : Effect.succeed(opened(current));
              }),
            watch: () => Stream.make(batch),
          })
        )
      );

      const result = yield* consume(
        mailbox,
        recipientDid,
        (message, meta) =>
          Effect.sync(() => {
            expect(message.body).toBe(`${meta.seq}`);
            steps.push(`handle ${meta.seq}`);
          }),
        {
          harness: lease.harness,
          onSkip: ({ reason, seq }) =>
            Effect.sync(() => {
              steps.push(`skip ${seq} ${reason}`);
            }),
          unopenable: (event) =>
            Effect.sync(() => {
              steps.push(`recover? ${event.seq}`);

              return outcomeAt(event.seq) === "recovers"
                ? Option.some(opened(event.seq))
                : Option.none();
            }),
        }
      ).pipe(Effect.result);

      expect(Result.isSuccess(result)).toBe(true);
      expect(steps).toEqual(
        seqs.flatMap((seq) => expectedSteps(outcomeAt(seq), seq))
      );
    }).pipe(Effect.scoped)
);
