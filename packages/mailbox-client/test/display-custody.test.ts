import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as Lease from "@rat-king/lexicon/runtime.lease";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  Layer,
  Result,
  Schema,
  Stream,
} from "effect";
import { expect } from "vitest";

import { sealed, recipientDid } from "../../envelope/test/helpers.ts";
import { consume } from "../src/consume.ts";
import type { MessageMeta } from "../src/consume.ts";
import { MailboxClientError } from "../src/error.ts";
import { RatKingMailbox } from "../src/mailbox.ts";

it.effect.prop(
  "manual custody acknowledges only explicit display, dedupes replay and keeps legacy handler acknowledgments",
  [Arbitrary.schema(Schema.Boolean), Arbitrary.schema(Schema.Boolean)],
  ([manual, immediate]) =>
    Effect.gen(function* proof() {
      const sample = yield* sealed();
      const now = yield* Clock.currentTimeMillis;

      const lease = yield* Schema.decodeUnknownEffect(Lease.Main)({
        did: recipientDid,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 300_000)),
        generation: 1,
        harness: {
          $type: "sh.mschf.ratking.runtime.lease#pi",
          sessionId: "display",
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
        state: "delivered",
      });

      const event = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.MessageEvent)
      )({
        $type: "sh.mschf.ratking.defs#messageEvent",
        envelope: sample.envelope,
        receipt,
        seq: 1,
      });

      const meta: MessageMeta[] = [];
      let acknowledgments = 0;
      let rejectExpired = false;

      const mailbox = yield* RatKingMailbox.pipe(
        Effect.provide(
          Layer.mock(RatKingMailbox, {
            ack: (input) =>
              Effect.gen(function* acknowledge() {
                expect(input.generation).toBe(1);
                expect(input.leaseId).toBe(lease.leaseId);
                acknowledgments += 1;

                if (rejectExpired) {
                  return yield* new MailboxClientError({
                    error: "InvalidTransition",
                    reason: "Expired message",
                  });
                }

                return { receipt };
              }),
            deliver: () => Effect.succeed({ receipt }),
            lease: {
              acquire: () => Effect.succeed(lease),
              release: () => Effect.void,
              renew: () => Effect.succeed(lease),
              resolve: () => Effect.succeed(lease),
            },
            open: () =>
              Effect.succeed({
                body: "mail",
                senderDid: sample.envelope.aad.senderDid,
                tid: sample.envelope.aad.messageId,
                verified: true,
              }),
            watch: () =>
              Stream.make({
                events: [
                  { ...event, $type: "sh.mschf.ratking.defs#messageEvent" },
                  {
                    ...event,
                    $type: "sh.mschf.ratking.defs#messageEvent",
                    seq: 2,
                  },
                ],
                throughSeq: 2,
              }),
          })
        )
      );

      yield* consume(
        mailbox,
        recipientDid,
        (_message, received) =>
          Effect.sync(() => {
            meta.push(received);
          }).pipe(
            Effect.andThen(manual && immediate ? received.ack : Effect.void)
          ),
        { ackOnReturn: !manual, harness: lease.harness }
      );
      expect(meta.length).toBe(manual ? 1 : 2);
      expect(acknowledgments).toBe(manual ? Number(immediate) : 2);

      if (manual && !immediate) {
        yield* Effect.all(meta.map((received) => received.ack));
        expect(acknowledgments).toBe(1);
      }

      rejectExpired = true;

      for (const message of meta) {
        const result = yield* message.ack.pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* message.ackOutcome).toBe("expired");
      }
    }).pipe(Effect.scoped)
);
