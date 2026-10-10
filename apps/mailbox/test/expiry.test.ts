import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import * as Renew from "@rat-king/lexicon/runtime.renewLease";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  Layer,
  Logger,
  Schema,
  Stream,
} from "effect";
import { CurrentLogAnnotations } from "effect/References";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { consume } from "../../../packages/mailbox-client/src/consume.ts";
import { clientError } from "../../../packages/mailbox-client/src/error.ts";
import { RatKingMailbox } from "../../../packages/mailbox-client/src/mailbox.ts";
import { staticResolver } from "../src/auth.ts";
import { logFailure } from "../src/failure-log.ts";
import { Caller, handlersLayer } from "../src/mailbox.ts";
import { tid } from "../src/tid.ts";
import { documents, testStore, unleasedSender } from "./helpers.ts";

const LoggedFailure = Schema.Struct({
  detail: Schema.String,
  error: Schema.String,
  method: Schema.String,
  recipient: Schema.String,
  seq: Schema.Int,
  status: Schema.Int,
});

const services = Effect.gen(function* services() {
  const sample = yield* sealed();

  const docs = yield* documents(
    sample.keys.sender.publicKey,
    sample.keys.recipient.publicKey
  );

  const storage = yield* testStore;

  const handlers = (did: string) =>
    Effect.gen(function* handlerService() {
      return yield* MailboxHandlers;
    }).pipe(
      Effect.provide(
        handlersLayer.pipe(
          Layer.provide(unleasedSender),
          Layer.provide(storage.layer),
          Layer.provide(staticResolver(docs)),
          Layer.provide(Layer.succeed(Caller, { did }))
        )
      )
    );

  const sender = yield* handlers(senderDid);
  const recipient = yield* handlers(recipientDid);
  const now = yield* Clock.currentTimeMillis;

  const send = (index: number, ttl: number) =>
    Effect.gen(function* sendMessage() {
      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.EncryptedEnvelope)
      )({
        ...sample.envelope,
        aad: {
          ...sample.envelope.aad,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + ttl)),
          messageId: tid(now, index),
        },
      });

      return (yield* sender.send({ envelope })).receipt;
    });

  return { recipient, send };
});

it.effect.prop(
  "a consumer skips expired messages, including the head, and handles every later live one",
  [Arbitrary.schema(Schema.Array(Schema.Boolean).check(Schema.isMaxLength(5)))],
  ([tail]) =>
    Effect.gen(function* expiredHeadProof() {
      const { recipient, send } = yield* services;
      const expired = [true, ...tail];
      const receipts = [];

      for (const [index, dies] of expired.entries()) {
        receipts.push(yield* send(index, dies ? 1000 : 600_000));
      }

      yield* TestClock.adjust(1001);

      const mailbox = RatKingMailbox.of({
        ack: (input) =>
          Schema.decodeUnknownEffect(Ack.Input)({
            ...input,
            recipientDid,
          }).pipe(Effect.flatMap(recipient.ack), Effect.mapError(clientError)),
        deliver: (input) =>
          Schema.decodeUnknownEffect(Deliver.Input)({
            ...input,
            recipientDid,
          }).pipe(
            Effect.flatMap(recipient.deliver),
            Effect.mapError(clientError)
          ),
        lease: {
          acquire: (input) =>
            Schema.decodeUnknownEffect(Acquire.Input)(input).pipe(
              Effect.flatMap(recipient.acquireLease),
              Effect.map(({ lease }) => lease),
              Effect.mapError(clientError)
            ),
          release: (input) =>
            Schema.decodeUnknownEffect(Release.Input)(input).pipe(
              Effect.flatMap(recipient.releaseLease),
              Effect.mapError(clientError)
            ),
          renew: (input) =>
            Schema.decodeUnknownEffect(Renew.Input)(input).pipe(
              Effect.flatMap(recipient.renewLease),
              Effect.map(({ lease }) => lease),
              Effect.mapError(clientError)
            ),
          resolve: (did) =>
            Schema.decodeUnknownEffect(Resolve.Params)({ did }).pipe(
              Effect.flatMap(recipient.resolveLease),
              Effect.map(({ lease }) => lease),
              Effect.mapError(clientError)
            ),
        },
        list: () => Effect.die("unused"),
        open: (envelope) =>
          Effect.succeed({
            body: "",
            senderDid: envelope.aad.senderDid,
            tid: envelope.aad.messageId,
            verified: true,
          }),
        poll: () => Effect.die("unused"),
        putDidDocument: () => Effect.die("unused"),
        send: () => Effect.die("unused"),
        watch: () =>
          Stream.fromEffect(
            Schema.decodeUnknownEffect(List.Params)({ recipientDid }).pipe(
              Effect.flatMap(recipient.list),
              Effect.mapError(clientError)
            )
          ),
      });

      const handled: string[] = [];

      yield* consume(
        mailbox,
        recipientDid,
        (message) =>
          Effect.sync(() => {
            handled.push(message.tid);
          }),
        {
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId: "expiry",
          },
        }
      );

      expect(handled).toEqual(
        receipts.flatMap((receipt, index) =>
          expired[index] === true ? [] : [receipt.message.messageId]
        )
      );
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "expiry settles once and every later deliver or ack returns the same expired receipt",
  [
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(
      Schema.Array(Schema.Literals(["deliver", "ack"])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(6)
      )
    ),
  ],
  ([deliveredFirst, commands]) =>
    Effect.gen(function* idempotentExpiry() {
      const { recipient, send } = yield* services;
      const receipt = yield* send(0, 1000);
      const now = yield* Clock.currentTimeMillis;

      const { lease } = yield* recipient.acquireLease(
        yield* Schema.decodeUnknownEffect(Acquire.Input)({
          did: recipientDid,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 600_000)),
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId: "expiry",
          },
        })
      );

      const input = yield* Schema.decodeUnknownEffect(Deliver.Input)({
        generation: lease.generation,
        leaseId: lease.leaseId,
        message: receipt.message,
        recipientDid,
      });

      if (deliveredFirst) {
        yield* recipient.deliver(input);
      }

      yield* TestClock.adjust(1001);

      const outcomes = [];

      for (const command of commands) {
        outcomes.push(
          (yield* command === "deliver"
            ? recipient.deliver(input)
            : recipient.ack(input)).receipt
        );
      }

      const events = (yield* recipient.list(
        yield* Schema.decodeUnknownEffect(List.Params)({ recipientDid })
      )).events.filter(
        (event) =>
          Schema.is(Defs.ReceiptEvent)(event) &&
          event.receipt.state === "expired"
      );

      expect(outcomes.every((outcome) => outcome.state === "expired")).toBe(
        true
      );
      expect(new Set(outcomes.map((outcome) => outcome.seq)).size).toBe(1);
      expect(events.length).toBe(1);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a mailbox XRPC failure emits one warning with a hashed recipient and no DID",
  [Arbitrary.schema(Schema.Literals([200, 201, 400, 401, 403, 404, 409, 503]))],
  ([status]) =>
    Effect.gen(function* failureLogProof() {
      const lines: { level: string; fields: typeof LoggedFailure.Type }[] = [];

      const capture = Logger.make(({ fiber, logLevel }) => {
        lines.push({
          fields: Schema.decodeUnknownSync(LoggedFailure)(
            fiber.getRef(CurrentLogAnnotations)
          ),
          level: logLevel,
        });
      });

      yield* logFailure(
        { method: Deliver.Method.nsid, recipient: recipientDid, seq: 693 },
        Response.json(
          { error: "InvalidTransition", message: "Expired message" },
          { status }
        )
      ).pipe(Effect.provide(Logger.layer([capture])));

      expect(lines.length).toBe(status >= 400 ? 1 : 0);

      for (const line of lines) {
        expect(line.level).toBe("Warn");
        expect(line.fields).toMatchObject({
          detail: "Expired message",
          error: "InvalidTransition",
          method: Deliver.Method.nsid,
          seq: 693,
          status,
        });
        expect(JSON.stringify(line.fields)).not.toContain(recipientDid);
      }
    })
);
