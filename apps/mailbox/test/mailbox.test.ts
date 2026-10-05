import { it } from "@effect/vitest";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import {
  Caller,
  handlersLayer,
  LeaseAuthority,
  leaseLayer,
} from "../src/mailbox.ts";
import { documents, testStore } from "./helpers.ts";

it.effect(
  "SQL admission, canonical idempotency, snapshots, lease fencing and ack durability",
  () =>
    Effect.gen(function* mailboxProof() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const storage = yield* testStore;

      const senderLayer = handlersLayer.pipe(
        Layer.provide(storage.layer),
        Layer.provide(staticResolver(docs)),
        Layer.provide(Layer.succeed(Caller, { did: senderDid }))
      );

      const recipientLayer = handlersLayer.pipe(
        Layer.provide(storage.layer),
        Layer.provide(staticResolver(docs)),
        Layer.provide(Layer.succeed(Caller, { did: recipientDid }))
      );

      const sender = yield* Effect.gen(function* senderService() {
        return yield* MailboxHandlers;
      }).pipe(Effect.provide(senderLayer));

      const recipient = yield* Effect.gen(function* recipientService() {
        return yield* MailboxHandlers;
      }).pipe(Effect.provide(recipientLayer));

      const leases = yield* Effect.gen(function* leaseService() {
        return yield* LeaseAuthority;
      }).pipe(Effect.provide(leaseLayer.pipe(Layer.provide(storage.layer))));

      const first = yield* sender.send({ envelope: sample.envelope });
      expect(yield* sender.send({ envelope: sample.envelope })).toEqual(first);
      expect(
        (yield* sender
          .send({
            envelope: { ...sample.envelope, ciphertext: new Uint8Array([1]) },
          })
          .pipe(Effect.exit))._tag
      ).toBe("Failure");
      expect(
        (yield* recipient.send({ envelope: sample.envelope }).pipe(Effect.exit))
          ._tag
      ).toBe("Failure");

      const params = yield* Schema.decodeUnknownEffect(List.Params)({
        limit: 1,
        recipientDid,
      });

      const read = yield* recipient.list(params);
      expect(read.throughSeq).toBe(1);
      expect(read.events.length).toBe(1);
      expect(read.cursor).toBeUndefined();
      const leaseId = "3m7x2ka4xv22b";
      const firstLease = yield* leases.acquire(leaseId, 1000);

      const ack = yield* Schema.decodeUnknownEffect(Ack.Input)({
        generation: firstLease.generation,
        leaseId,
        message: first.receipt.message,
        recipientDid,
      });

      expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe(
        "Failure"
      );
      yield* leases.inject(
        senderDid,
        sample.envelope.aad.messageId,
        leaseId,
        firstLease.generation
      );
      const page1 = yield* recipient.list(params);
      expect(page1.throughSeq).toBe(3);
      expect(page1.cursor).toBeDefined();
      const rebound = yield* leases.acquire(leaseId, 1000);
      expect(rebound.generation).toBe(2);
      expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe(
        "Failure"
      );
      const valid = { ...ack, generation: rebound.generation };
      const acknowledged = yield* recipient.ack(valid);
      expect(acknowledged.receipt.state).toBe("acked");
      expect(yield* recipient.ack(valid)).toEqual(acknowledged);
      expect(yield* sender.send({ envelope: sample.envelope })).toEqual(first);

      const nextParams = yield* Schema.decodeUnknownEffect(List.Params)({
        cursor: page1.cursor,
        limit: 1,
        recipientDid,
      });

      const page2 = yield* recipient.list(nextParams);
      expect(page2.throughSeq).toBe(3);
      expect(page2.events[0]?.seq).toBe(2);

      const page3 = yield* recipient.list({
        ...nextParams,
        cursor: page2.cursor ?? "",
      });

      expect(page3.throughSeq).toBe(3);
      expect(page3.events[0]?.seq).toBe(3);
      expect(page3.cursor).toBeUndefined();
      expect((yield* sender.list(params).pipe(Effect.exit))._tag).toBe(
        "Failure"
      );
      expect(
        (yield* recipient.list({ ...params, afterSeq: 10 }).pipe(Effect.exit))
          ._tag
      ).toBe("Failure");
      yield* TestClock.adjust(1001);
      expect((yield* recipient.ack(valid).pipe(Effect.exit))._tag).toBe(
        "Failure"
      );
      expect(
        (yield* leases
          .renew(leaseId, rebound.generation, 1000)
          .pipe(Effect.exit))._tag
      ).toBe("Failure");
    }).pipe(Effect.scoped)
);
