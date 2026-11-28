import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Page from "@rat-king/lexicon/mailbox.listPage";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { staticResolver } from "../src/auth.ts";
import { pendingPush, registerDevice } from "../src/device.ts";
import { listPage } from "../src/inbox-page.ts";
import {
  Caller,
  deliverMessage,
  handlersLayer,
  transitionMessage,
} from "../src/mailbox.ts";
import { redeliver } from "../src/redelivery.ts";
import { MailboxStore } from "../src/store.ts";
import type { Message, Transaction } from "../src/store.ts";
import { tid } from "../src/tid.ts";
import { testStoreFor, unleasedSender } from "./helpers.ts";
import {
  alpha,
  did,
  envelope,
  epoch,
  integer,
  iso,
  receipt,
  serial,
} from "./mailbox-rule-inputs.ts";

const sender = "did:web:sender.example.invalid";

const recipient = "did:web:recipient.example.invalid";

const store = testStoreFor(recipient);

const baseEnvelope = (at: number, n: number, expiry?: number) => {
  const route = {
    messageId: tid(at, n),
    recipientDid: recipient,
    recipientKeyId: `${recipient}#enc`,
    senderDid: sender,
  };

  return {
    aad: expiry === undefined ? route : { ...route, expiresAt: iso(expiry) },
    ciphertext: { $bytes: "AQ==" },
    enc: { $bytes: "Ag==" },
    suite: { aeadId: 2, kdfId: 1, kemId: 16 },
    version: 1,
  };
};

const fixture = (
  state: string,
  at: number,
  n: number,
  expiry?: number
): Message => {
  const box = envelope(baseEnvelope(at, n, expiry));

  const current = receipt({
    message: { messageId: box.aad.messageId, senderDid: sender },
    recipientDid: recipient,
    recordedAt: iso(at),
    seq: n,
    state,
  });

  return {
    admission: { ...current, state: "accepted" },
    canonicalBytes: `example-${n}`,
    current,
    envelope: box,
  };
};

const put = (tx: Transaction, message: Message) => {
  tx.append({
    $type: "sh.mschf.ratking.defs#messageEvent",
    envelope: message.envelope,
    receipt: message.current,
    seq: message.current.seq,
  });
  tx.put(message);
};

const install = (
  message: Message,
  action: (tx: Transaction) => Defs.ReceiptValue
) =>
  Effect.gen(function* installed() {
    const storage = yield* store;
    const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
    yield* service.transaction((tx) => {
      put(tx, message);
    });

    return yield* service.transaction(action);
  }).pipe(Effect.scoped);

const deliver = (message: Message, at: number) =>
  install(message, (tx) =>
    deliverMessage(tx, sender, message.envelope.aad.messageId, at)
  );

it.effect.prop(
  "a delivery at the exact expiry settles expired instead of injecting",
  [
    epoch,
    integer(1, 200),
    Schema.Literals(["accepted", "queued", "delivered"]),
  ],
  ([now, n, state]) =>
    Effect.gen(function* atExpiry() {
      const message = fixture(state, now - 1, n, now);
      const result = yield* deliver(message, now);
      expect(result).toMatchObject({
        recordedAt: iso(now),
        seq: n + 1,
        state: "expired",
      });
    })
);

it.effect.prop(
  "a queued delivery one millisecond before expiry still injects",
  [epoch, integer(1, 200)],
  ([now, n]) =>
    Effect.gen(function* beforeExpiry() {
      const result = yield* deliver(
        fixture("queued", now - 1, n, now + 1),
        now
      );

      expect(result).toMatchObject({
        recordedAt: iso(now),
        seq: n + 1,
        state: "delivered",
      });
    })
);

it.effect.prop(
  "delivery never infers a sender expiry from the age of an old TID",
  [epoch, integer(1, 100), integer(1, 200)],
  ([now, days, n]) =>
    Effect.gen(function* noExpiry() {
      const box = fixture("accepted", now - days * 86_400_000, n);
      const result = yield* deliver(box, now);
      expect(result).toMatchObject({ seq: n + 2, state: "delivered" });
    })
);

it.effect.prop(
  "delivery leaves an acknowledged or already expired receipt unchanged",
  [epoch, integer(1, 200), Schema.Literals(["acked", "expired"])],
  ([now, n, state]) =>
    Effect.gen(function* terminalReceipt() {
      const box = fixture(state, now, n, now);
      expect(yield* deliver(box, now + 1)).toEqual(box.current);
    })
);

it.effect.prop(
  "a delivered message without a reached deadline can be reinjected idempotently",
  [epoch, integer(1, 200), serial],
  ([at, n, gap]) =>
    Effect.gen(function* repeatDelivery() {
      const message = fixture("delivered", at, n, at + gap + 1);
      expect(yield* deliver(message, at + gap)).toEqual(message.current);
    })
);

it.effect.prop(
  "the application cannot advance an unknown open-enum receipt state",
  [epoch, integer(1, 200), alpha],
  ([now, n, label]) =>
    Effect.gen(function* unknownState() {
      const message = fixture(`future-${label}`, now, n);

      const result = yield* install(message, (tx) =>
        transitionMessage(tx, message, "queue", now + 1)
      ).pipe(Effect.result);

      expect(result).toMatchObject({ failure: { error: "InvalidTransition" } });
    })
);

it.effect.prop(
  "a terminal transition carries caller-supplied detail and retains admission identity",
  [epoch, integer(1, 200), alpha],
  ([at, n, label]) =>
    Effect.gen(function* terminalDetail() {
      const message = fixture("queued", at, n);
      const detail = `test-${label}`;

      const result = yield* install(message, (tx) =>
        transitionMessage(tx, message, "fail", at + 1, detail)
      );

      expect(result).toMatchObject({
        detail,
        message: message.current.message,
        recipientDid: recipient,
        recordedAt: iso(at + 1),
        state: "failed",
      });
    })
);

it.effect.prop(
  "redelivery excludes exactly expired rows while keeping unexpired and undated rows",
  [epoch, integer(1, 200)],
  ([now, lag]) =>
    Effect.gen(function* pendingReplays() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const expired = fixture("delivered", now - lag, 1, now);
      const live = fixture("delivered", now - lag, 2, now + 1);
      const undated = fixture("delivered", now - lag, 3);

      const events = yield* service.transaction((tx) => {
        for (const item of [expired, live, undated]) {
          put(tx, item);
        }

        redeliver(tx, now);

        return tx.events(3, tx.watermark(), 10);
      });

      expect(events).toMatchObject([
        { receipt: { message: { messageId: live.envelope.aad.messageId } } },
        { receipt: { message: { messageId: undated.envelope.aad.messageId } } },
      ]);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "redelivery appends a new event sequence without changing the delivered receipt",
  [epoch, integer(1, 200)],
  ([now, n]) =>
    Effect.gen(function* receiptReplay() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const message = fixture("delivered", now, n);

      const result = yield* service.transaction((tx) => {
        put(tx, message);
        redeliver(tx, now + 1);

        return {
          events: tx.events(n, tx.watermark(), 10),
          stored: tx.get(sender, message.envelope.aad.messageId),
        };
      });

      expect(result.stored?.current).toEqual(message.current);
      expect(result.events).toMatchObject([
        { receipt: message.current, seq: n + 1 },
      ]);
    }).pipe(Effect.scoped)
);

it.prop(
  "envelope wire decoding retains a declared expiry and never invents one when omitted",
  [epoch, integer(1, 200), Schema.Boolean],
  ([at, n, expiring]) => {
    const expires = at + n;
    const wire = baseEnvelope(at, n, expiring ? expires : undefined);
    const decoded = envelope(wire);
    expect(decoded.aad.expiresAt).toBe(expiring ? iso(expires) : undefined);
  }
);

it.effect.prop(
  "admission refuses an unknown envelope version before looking up recipient keys",
  [epoch, integer(2, 200)],
  ([now, version]) =>
    Effect.gen(function* unsupportedVersion() {
      const storage = yield* store;

      const handlers = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                storage.layer,
                staticResolver([]),
                unleasedSender,
                Layer.succeed(Caller, { did: sender })
              )
            )
          )
        )
      );

      const result = yield* handlers
        .send({ envelope: envelope({ ...baseEnvelope(now, 1), version }) })
        .pipe(Effect.result);

      expect(result).toMatchObject({
        failure: { error: "UnsupportedEnvelope" },
      });
    }).pipe(Effect.scoped)
);

const decodeEnvelope = Schema.decodeUnknownOption(Defs.EncryptedEnvelope);

it.prop(
  "an empty wrapped ciphertext or encapsulation does not decode as an envelope",
  [epoch, integer(1, 200), Schema.Literals(["ciphertext", "enc"])],
  ([at, n, field]) => {
    expect(
      decodeEnvelope({ ...baseEnvelope(at, n), [field]: { $bytes: "" } })._tag
    ).toBe("None");
  }
);

it.prop(
  "invalid AAD message IDs cannot reach expiry or routing decisions",
  [epoch, integer(1, 200), alpha],
  ([at, n, label]) => {
    const wire = baseEnvelope(at, n);
    expect(
      decodeEnvelope({
        ...wire,
        aad: { ...wire.aad, messageId: `invalid-${label}` },
      })._tag
    ).toBe("None");
  }
);

const page = Schema.decodeUnknownSync(Page.Params);

it.effect.prop(
  "incremental pages refuse a simultaneous before position even when both are valid",
  [integer(1, 8000), integer(1, 8000)],
  ([afterSeq, beforeSeq]) =>
    Effect.gen(function* cursorAmbiguity() {
      const storage = yield* store;

      const result = yield* listPage(
        page({ afterSeq, beforeSeq, recipientDid: recipient }),
        recipient
      ).pipe(Effect.provide(storage.layer), Effect.result);

      expect(result).toMatchObject({ failure: { error: "InvalidCursor" } });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "opening a snapshot for a different cell fails even when caller equals the requested recipient",
  [serial],
  ([n]) =>
    Effect.gen(function* wrongCell() {
      const storage = yield* store;
      const other = did(n);

      const result = yield* listPage(page({ recipientDid: other }), other).pipe(
        Effect.provide(storage.layer),
        Effect.result
      );

      expect(result).toMatchObject({ failure: { error: "Forbidden" } });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "incremental pages identify the last emitted event rather than the lookahead or watermark",
  [epoch, integer(1, 6), integer(1, 4)],
  ([now, n, limit]) =>
    Effect.gen(function* nextIncrement() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const end = n + limit + 1;
      yield* service.transaction((tx) => {
        for (let seq = 1; seq <= end; seq += 1) {
          put(tx, fixture("accepted", now + seq, seq));
        }
      });

      const result = yield* listPage(
        page({ afterSeq: n, limit, recipientDid: recipient }),
        recipient
      ).pipe(Effect.provide(storage.layer));

      expect(result.events.map(({ seq }) => seq)).toEqual(
        Array.from({ length: limit }, (_, i) => n + i + 1)
      );
      expect(result).toMatchObject({ latestSeq: end, nextAfterSeq: end - 1 });
    }).pipe(Effect.scoped)
);

const pushOperator = "did:web:push-operator.example.invalid";

const register = (token: string) =>
  JSON.stringify({ did: recipient, environment: "sandbox", token });

it.effect.prop(
  "device registration rejects odd-length hex rather than rounding a half-byte",
  [integer(1, 254)],
  ([n]) =>
    Effect.gen(function* oddToken() {
      const storage = yield* store;

      const result = yield* registerDevice(
        storage.sql,
        recipient,
        recipient,
        register(`${"ab".repeat(n)}c`)
      ).pipe(Effect.result);

      expect(result).toMatchObject({ failure: { error: "InvalidRequest" } });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a retired name cannot register a new push destination despite matching its identity",
  [epoch, serial],
  ([now, n]) =>
    Effect.gen(function* retiredDevice() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      yield* service.transaction((tx) => {
        tx.setRetirement({ by: did(n), name: "recipient", retiredAt: now });
      });

      const result = yield* registerDevice(
        storage.sql,
        recipient,
        recipient,
        register("AB")
      ).pipe(Effect.result);

      expect(result).toMatchObject({ failure: { error: "Forbidden" } });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "push projection skips a newer message at its exact expiry and selects older live mail",
  [epoch, integer(1, 200)],
  ([now, offset]) =>
    Effect.gen(function* pushExpiry() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const active = fixture("accepted", now - offset - 1, 1, now + 1);
      yield* service.transaction((tx) => {
        put(tx, active);
        put(tx, fixture("accepted", now - offset, 2, now));
      });
      yield* registerDevice(storage.sql, recipient, recipient, register("aB"));
      yield* TestClock.setTime(now);

      const output = yield* pendingPush(storage.sql, pushOperator, [
        pushOperator,
      ]);

      expect(output).toMatchObject({
        notice: {
          admissionSeq: 1,
          messageId: active.envelope.aad.messageId,
          token: "ab",
        },
      });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a quiet admission cannot be selected for push even if it is the newest receipt",
  [epoch, integer(1, 200)],
  ([now, n]) =>
    Effect.gen(function* quietPush() {
      const storage = yield* store;
      const service = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const live = fixture("accepted", now, n);
      const quiet = fixture("accepted", now + 1, n + 1);
      yield* service.transaction((tx) => {
        put(tx, live);
        put(tx, { ...quiet, admission: { ...quiet.admission, woke: false } });
      });
      yield* registerDevice(storage.sql, recipient, recipient, register("ab"));
      yield* TestClock.setTime(now + 2);

      const output = yield* pendingPush(storage.sql, pushOperator, [
        pushOperator,
      ]);

      expect(output).toMatchObject({
        notice: { messageId: live.envelope.aad.messageId },
      });
    }).pipe(Effect.scoped)
);
