import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import { Clock, DateTime, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { sealed, senderDid } from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller, handlersLayer } from "../src/mailbox.ts";
import { TerminalDelivery, terminalLayer } from "../src/terminal.ts";
import { documents, testStore } from "./helpers.ts";

it.effect(
  "terminal receipts are durable, cannot revive, and expiry is sender-controlled",
  () =>
    Effect.gen(function* terminalProof() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const storage = yield* testStore;

      const sender = yield* Effect.gen(function* senderService() {
        return yield* MailboxHandlers;
      }).pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(storage.layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(Layer.succeed(Caller, { did: senderDid }))
          )
        )
      );

      const terminal = yield* Effect.gen(function* terminalService() {
        return yield* TerminalDelivery;
      }).pipe(Effect.provide(terminalLayer.pipe(Layer.provide(storage.layer))));

      const now = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(now + 1000));

      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.EncryptedEnvelope)
      )({ ...sample.envelope, aad: { ...sample.envelope.aad, expiresAt } });

      yield* sender.send({ envelope });
      const senderId = envelope.aad.senderDid;
      const tid = envelope.aad.messageId;
      expect(
        (yield* terminal.settle(senderId, tid, "expire").pipe(Effect.exit))._tag
      ).toBe("Failure");
      yield* TestClock.adjust(1001);
      const expired = yield* terminal.settle(senderId, tid, "expire");
      expect(expired.state).toBe("expired");
      expect(yield* terminal.settle(senderId, tid, "expire")).toEqual(expired);
      expect(
        (yield* terminal.settle(senderId, tid, "fail").pipe(Effect.exit))._tag
      ).toBe("Failure");
      expect((yield* sender.send({ envelope })).receipt.state).toBe("accepted");
    }).pipe(Effect.scoped)
);
