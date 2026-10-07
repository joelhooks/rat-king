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
import { RatKingMailbox } from "../src/mailbox.ts";
import type { Batch } from "../src/mailbox.ts";

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
