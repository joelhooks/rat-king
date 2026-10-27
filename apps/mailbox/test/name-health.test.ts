import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import { Clock, DateTime, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  sealed,
  recipientDid,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { wakeIntent } from "../../../packages/mailbox-client/src/payload.ts";
import { staticResolver } from "../src/auth.ts";
import {
  Caller,
  handlersLayer,
  LeaseAuthority,
  leaseLayer,
} from "../src/mailbox.ts";
import { nameHealth } from "../src/name-health.ts";
import { documents, testStore, unleasedSender } from "./helpers.ts";

const Inputs = Schema.Struct({
  declared: Schema.Boolean,
  kind: Schema.Literals(["message", "data"]),
  primary: Schema.Boolean,
  quiet: Schema.Boolean,
});

const operator = "did:web:operator.example.invalid";

for (const state of [
  "accepted",
  "queued",
  "delivered",
  "acked",
  "expired",
  "failed",
]) {
  it.effect.prop(
    `${state} mail contributes to health only while unacknowledged, without a reader`,
    [Inputs],
    ([input]) =>
      Effect.gen(function* proof() {
        const sample = yield* sealed();
        const storage = yield* testStore;
        const intent = wakeIntent(input.kind, input.primary, input.quiet);

        const receipt = yield* Schema.decodeUnknownEffect(Defs.Receipt)({
          message: {
            messageId: sample.envelope.aad.messageId,
            senderDid,
          },
          recipientDid,
          recordedAt: "2026-10-11T00:00:00.000Z",
          seq: 1,
          state,
        });

        if (input.declared) {
          Object.assign(receipt, intent);
        }

        const envelope = yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(
          sample.envelope
        );

        storage.sql.exec(
          "INSERT INTO messages (sender,tid,value) VALUES (?,?,?)",
          senderDid,
          receipt.message.messageId,
          JSON.stringify({
            admission: { ...receipt, state: "accepted" },
            current: receipt,
            envelope,
          })
        );

        const params = yield* Schema.decodeUnknownEffect(Health.Params)({
          name: "recipient",
          recipientDid,
        });

        const health = yield* nameHealth(storage.sql, params, operator, [
          operator,
        ]);

        const pending = ["accepted", "queued", "delivered"].includes(state);

        expect(health.lease).toBeUndefined();
        expect(health.complete).toBe(!pending || input.declared);
        expect(health.quietUnacked).toBe(
          pending && input.declared && !intent.woke && input.kind !== "data"
            ? 1
            : 0
        );
        expect(health.oldestWake).toEqual(
          pending && input.declared && intent.woke
            ? {
                id: receipt.message.messageId,
                recordedAt: receipt.recordedAt,
                sender: senderDid,
                woke: true,
              }
            : undefined
        );
      }).pipe(Effect.scoped)
  );
}

it.effect.prop(
  "unacknowledged health keeps its 10000-row bound and reports truncation",
  [
    Schema.Int.check(Schema.isBetween({ maximum: 10_001, minimum: 9999 })),
    Schema.Literals(["accepted", "queued", "delivered"]),
  ],
  ([count, state]) =>
    Effect.gen(function* proof() {
      const sample = yield* sealed();
      const storage = yield* testStore;

      const receipt = yield* Schema.decodeUnknownEffect(Defs.Receipt)({
        message: {
          messageId: sample.envelope.aad.messageId,
          senderDid,
        },
        recipientDid,
        recordedAt: "2026-10-11T00:00:00.000Z",
        seq: 1,
        state,
        wakeReason: "quiet",
        woke: false,
      });

      storage.sql.exec(
        "WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<?) INSERT INTO messages (sender,tid,value) SELECT ?,CAST(n AS TEXT),json_set(?,'$.admission.seq',n,'$.current.seq',n) FROM rows",
        count,
        senderDid,
        JSON.stringify({ admission: receipt, current: receipt })
      );

      const params = yield* Schema.decodeUnknownEffect(Health.Params)({
        name: "recipient",
        recipientDid,
      });

      const health = yield* nameHealth(storage.sql, params, operator, [
        operator,
      ]);

      expect(health.complete).toBe(count <= 10_000);
      expect(health.quietUnacked).toBe(Math.min(count, 10_000));
      expect(health.oldestWake).toBeUndefined();
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 6 } }
);

it.effect.prop(
  "encrypted routing intent survives admission and delivery; ack clears metadata without exposing content",
  [Inputs],
  ([input]) =>
    Effect.gen(function* proof() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const storage = yield* testStore;

      const sender = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(unleasedSender),
            Layer.provide(storage.layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(Layer.succeed(Caller, { did: senderDid }))
          )
        )
      );

      const recipient = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(unleasedSender),
            Layer.provide(storage.layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(Layer.succeed(Caller, { did: recipientDid }))
          )
        )
      );

      const leases = yield* LeaseAuthority.pipe(
        Effect.provide(leaseLayer.pipe(Layer.provide(storage.layer)))
      );

      yield* TestClock.setTime(1_791_676_800_000);

      const intent = wakeIntent(input.kind, input.primary, input.quiet);

      const admitted = yield* sender.send(
        input.declared
          ? { envelope: sample.envelope, ...intent }
          : { envelope: sample.envelope }
      );

      expect(admitted.receipt.woke).toBe(
        input.declared ? intent.woke : undefined
      );
      expect(admitted.receipt.wakeReason).toBe(
        input.declared ? intent.wakeReason : undefined
      );

      const lease = yield* leases.acquire(
        yield* Schema.decodeUnknownEffect(Acquire.Input)({
          did: recipientDid,
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 600_000)
          ),
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            paneId: "test-pane",
            sessionId: "test-session",
          },
        })
      );

      const fence = {
        generation: lease.generation,
        leaseId: lease.leaseId,
        message: admitted.receipt.message,
        recipientDid: lease.did,
      };

      yield* recipient.deliver(fence);

      const params = yield* Schema.decodeUnknownEffect(Health.Params)({
        name: "recipient",
        recipientDid,
      });

      const before = yield* nameHealth(storage.sql, params, operator, [
        operator,
      ]);

      expect(before.complete).toBe(input.declared);
      expect(before.quietUnacked).toBe(
        input.declared && !intent.woke && input.kind !== "data" ? 1 : 0
      );
      expect(before.lease?.holder).toBe("test-session");
      expect(before.oldestWake?.id).toBe(
        input.declared && intent.woke
          ? admitted.receipt.message.messageId
          : undefined
      );
      expect(Object.keys(before).toSorted()).toEqual(
        input.declared && intent.woke
          ? [
              "complete",
              "lease",
              "oldestWake",
              "oldestWakeSinceAck",
              "quietUnacked",
              "wakesSinceAck",
            ]
          : ["complete", "lease", "quietUnacked"]
      );
      expect(Object.keys(before.lease ?? {}).toSorted()).toEqual([
        "expiresAt",
        "generation",
        "holder",
        "pane",
      ]);

      if (before.oldestWake !== undefined) {
        expect(Object.keys(before.oldestWake).toSorted()).toEqual([
          "id",
          "recordedAt",
          "sender",
          "woke",
        ]);
      }

      expect(JSON.stringify(before)).not.toContain("ciphertext");
      expect(Object.keys(Health.Output.schema.fields).toSorted()).toEqual([
        "complete",
        "lastAck",
        "lease",
        "oldestWake",
        "oldestWakeSinceAck",
        "quietUnacked",
        "wakesSinceAck",
      ]);

      const denied = yield* nameHealth(storage.sql, params, recipientDid, [
        operator,
      ]).pipe(Effect.flip);

      expect(denied.error).toBe("Forbidden");

      yield* TestClock.adjust(181_000);
      yield* recipient.ack(fence);

      const after = yield* nameHealth(storage.sql, params, operator, [
        operator,
      ]);

      expect(after.oldestWake).toBeUndefined();
      expect(after.quietUnacked).toBe(0);
      expect(after.lastAck).toBe("2026-10-11T00:03:01.000Z");
      expect(after.lease).toEqual(before.lease);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "the oldest wake since the last ack ignores earlier unacked mail in every pending state",
  [
    Schema.Literals(["accepted", "queued", "delivered"]),
    Schema.Literals(["accepted", "queued", "delivered"]),
    Schema.Boolean,
  ],
  ([before, after, acked]) =>
    Effect.gen(function* proof() {
      const sample = yield* sealed();
      const storage = yield* testStore;

      const insert = (id: string, state: string, recordedAt: string) =>
        Effect.gen(function* put() {
          const receipt = yield* Schema.decodeUnknownEffect(Defs.Receipt)({
            message: { messageId: id, senderDid },
            recipientDid,
            recordedAt,
            seq: 1,
            state,
            wakeReason: "primary",
            woke: true,
          });

          storage.sql.exec(
            "INSERT INTO messages (sender,tid,value) VALUES (?,?,?)",
            senderDid,
            id,
            JSON.stringify({
              admission: { ...receipt, state: "accepted" },
              current: receipt,
            })
          );
        });

      yield* insert(
        sample.envelope.aad.messageId,
        before,
        "2026-10-11T00:00:00.000Z"
      );

      if (acked) {
        yield* insert("2222222222222", "acked", "2026-10-11T01:00:00.000Z");
      }

      yield* insert("3333333333333", after, "2026-10-11T02:00:00.000Z");

      const params = yield* Schema.decodeUnknownEffect(Health.Params)({
        name: "recipient",
        recipientDid,
      });

      const health = yield* nameHealth(storage.sql, params, operator, [
        operator,
      ]);

      expect(health.oldestWake?.recordedAt).toBe("2026-10-11T00:00:00.000Z");
      expect(health.oldestWakeSinceAck?.recordedAt).toBe(
        acked ? "2026-10-11T02:00:00.000Z" : "2026-10-11T00:00:00.000Z"
      );
      expect(health.wakesSinceAck).toBe(acked ? 1 : 2);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 9 } }
);

it.effect("a reader that acked everything has no wake since the ack", () =>
  Effect.gen(function* proof() {
    const sample = yield* sealed();
    const storage = yield* testStore;

    const insert = (id: string, state: string, recordedAt: string) =>
      Effect.gen(function* put() {
        const receipt = yield* Schema.decodeUnknownEffect(Defs.Receipt)({
          message: { messageId: id, senderDid },
          recipientDid,
          recordedAt,
          seq: 1,
          state,
          wakeReason: "primary",
          woke: true,
        });

        storage.sql.exec(
          "INSERT INTO messages (sender,tid,value) VALUES (?,?,?)",
          senderDid,
          id,
          JSON.stringify({
            admission: { ...receipt, state: "accepted" },
            current: receipt,
          })
        );
      });

    yield* insert(
      sample.envelope.aad.messageId,
      "queued",
      "2026-10-11T00:00:00.000Z"
    );

    yield* insert("2222222222222", "acked", "2026-10-11T01:00:00.000Z");

    const params = yield* Schema.decodeUnknownEffect(Health.Params)({
      name: "recipient",
      recipientDid,
    });

    const health = yield* nameHealth(storage.sql, params, operator, [operator]);

    expect(health.oldestWake?.recordedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(health.oldestWakeSinceAck).toBeUndefined();
    expect(health.wakesSinceAck).toBe(0);
  }).pipe(Effect.scoped)
);
