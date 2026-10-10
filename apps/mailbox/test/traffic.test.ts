// @effect-diagnostics asyncFunction:off -- fast-check AsyncCommand drives the synchronous SQL adapter.
/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Lazy Effect HTTP body reads return platform Promises. */
import { it } from "@effect/vitest";
import {
  canonical,
  canonicalDecode,
  plaintextSuite,
  seal,
  signingBytes,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import {
  Arbitrary,
  Clock,
  DateTime,
  Effect,
  Exit,
  Layer,
  Schema,
} from "effect";
import * as fc from "fast-check";
import { expect } from "vitest";

import {
  payload,
  recipientDid,
  senderDid,
  sealed,
} from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller, handlersLayer } from "../src/mailbox.ts";
import type { Sql } from "../src/sqlite.ts";
import { trafficRequest } from "../src/traffic-http.ts";
import {
  appendTraffic,
  listTraffic,
  pendingTraffic,
  TrafficEntry,
} from "../src/traffic-store.ts";
import { TestFailure } from "./celld.ts";
import { documents, testStore, unleasedSender } from "./helpers.ts";

const Limit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100)
);

it.effect.prop(
  "observer access is additive: observers read metadata, other methods fall through to normal identity authorization, strangers get 403 without data",
  [Arbitrary.schema(Limit)],
  ([limit]) =>
    Effect.gen(function* authorization() {
      let reads = 0;

      const call = (nsid: string, issuer: string, method: "GET" | "POST") =>
        trafficRequest({
          issuer,
          nsid,
          observers: ["did:web:observer.example.invalid"],
          operators: ["did:web:operator.example.invalid"],
          read: () =>
            Effect.sync(() => {
              reads += 1;

              return {
                body: JSON.stringify({ cursor: "0", events: [] }),
                status: 200,
              };
            }),
          request: new Request(
            `https://worker.example.invalid/xrpc/${nsid}?limit=${limit}`,
            { method }
          ),
        });

      expect(
        (yield* call(
          Traffic.Method.nsid,
          "did:web:observer.example.invalid",
          "GET"
        ))?.status
      ).toBe(200);
      expect(
        (yield* call(
          Traffic.Method.nsid,
          "did:web:operator.example.invalid",
          "GET"
        ))?.status
      ).toBe(200);

      for (const nsid of [
        "sh.mschf.ratking.mailbox.send",
        "sh.mschf.ratking.admin.putDidDocument",
        "sh.mschf.ratking.runtime.acquireLease",
        "sh.mschf.ratking.mailbox.list",
      ]) {
        expect(
          yield* call(
            nsid,
            "did:web:observer.example.invalid",
            nsid.endsWith(".list") ? "GET" : "POST"
          )
        ).toBeUndefined();
      }

      const stranger = yield* call(
        Traffic.Method.nsid,
        "did:web:stranger.example.invalid",
        "GET"
      );

      if (stranger === undefined) {
        return yield* Effect.die("Expected stranger refusal");
      }

      expect(stranger.status).toBe(403);
      expect(yield* Effect.promise(() => stranger.json())).toEqual({
        error: "Forbidden",
      });
      expect(reads).toBe(2);

      return yield* Effect.void;
    })
);

it.effect.prop(
  "journal retry and paging commands preserve a metadata-only sequence model",
  [
    Arbitrary.schema(
      Schema.Struct({
        ciphertextSize: TrafficEntry.fields.ciphertextSize,
        state: Schema.Literals([
          "accepted",
          "queued",
          "delivered",
          "acked",
          "expired",
          "failed",
        ]),
      })
    ),
    Arbitrary.schema(Schema.Array(Limit).check(Schema.isMaxLength(25))),
    Arbitrary.schema(Limit),
  ],
  ([entry, operations, limit]) =>
    Effect.gen(function* journalModel() {
      const { sql } = yield* testStore;
      const order: number[] = [];
      const model = { order, seen: new Set<number>() };

      const commands: fc.AsyncCommand<typeof model, Sql>[] = operations.map(
        (operation) => ({
          check: () => true,
          run: (state, database): Promise<void> => {
            const recipientSeq = (operation % 10) + 1;

            const projected = Schema.decodeUnknownSync(TrafficEntry)({
              ...entry,
              ciphertext: "must not escape",
              detail: "private",
              messageId: "3jzfcijpj2z2a",
              recipientDid: "did:web:recipient.example.invalid",
              recipientSeq,
              recordType: "private",
              senderDid: "did:web:sender.example.invalid",
              seq: 1,
              time: "2026-10-06T00:00:00Z",
            });

            appendTraffic(database, [projected]);
            appendTraffic(database, [projected]);

            if (!state.seen.has(recipientSeq)) {
              state.seen.add(recipientSeq);
              state.order.push(recipientSeq);
            }

            let cursor = "0";
            const received: number[] = [];
            let more = true;

            while (more) {
              const page = listTraffic(database, { cursor, limit });
              expect(page.events.length).toBeLessThanOrEqual(limit);

              for (const event of page.events) {
                expect(Object.keys(event).toSorted()).toEqual(
                  Object.keys(TrafficEntry.fields)
                    .filter((key) => key !== "body")
                    .toSorted()
                );
                received.push(event.recipientSeq);
              }

              ({ cursor } = page);
              more = page.events.length === limit;
            }

            expect(received).toEqual(state.order);
            expect(() => listTraffic(database, { cursor: "-1" })).toThrow();
            expect(() =>
              listTraffic(database, { cursor: String(Number(cursor) + 1) })
            ).toThrow();
            expect(pendingTraffic(database)).toEqual([]);

            return Promise.resolve();
          },
          toString: () => `append/retry/page ${operation}`,
        })
      );

      yield* Effect.tryPromise({
        catch: (cause) => new TestFailure({ message: String(cause) }),
        try: () => fc.asyncModelRun(() => ({ model, real: sql }), commands),
      });
    })
);

it.effect.prop(
  "mailbox commits capture every delivery transition once with ciphertext byte size and no encrypted fields",
  [Arbitrary.schema(Limit)],
  ([size]) =>
    Effect.gen(function* capture() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const { sql, layer } = yield* testStore;

      const handlers = (did: string) =>
        MailboxHandlers.pipe(
          Effect.provide(
            handlersLayer.pipe(
              Layer.provide(unleasedSender),
              Layer.provide(layer),
              Layer.provide(staticResolver(docs)),
              Layer.provide(Layer.succeed(Caller, { did }))
            )
          )
        );

      const sender = yield* handlers(senderDid);
      const recipient = yield* handlers(recipientDid);
      const envelope = { ...sample.envelope, ciphertext: new Uint8Array(size) };
      const admission = yield* sender.send({ envelope });
      yield* sender.send({ envelope });

      const { lease } = yield* recipient.acquireLease(
        yield* Schema.decodeUnknownEffect(Acquire.Input)({
          did: recipientDid,
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000)
          ),
          harness: {
            $type: "sh.mschf.ratking.runtime.lease#pi",
            sessionId: "traffic-test",
          },
        })
      );

      const input = {
        generation: lease.generation,
        leaseId: lease.leaseId,
        message: admission.receipt.message,
        recipientDid: envelope.aad.recipientDid,
      };

      yield* recipient.deliver(input);
      yield* recipient.ack(input);
      yield* recipient.ack(input);
      const entries = pendingTraffic(sql);
      expect(entries.map(({ state }) => state)).toEqual([
        "accepted",
        "queued",
        "delivered",
        "acked",
      ]);
      expect(entries.map(({ recipientSeq }) => recipientSeq)).toEqual([
        1, 2, 3, 4,
      ]);

      for (const entry of entries) {
        expect(entry.ciphertextSize).toBe(size);
        expect(entry.senderDid).toBe(senderDid);
        expect(entry.recipientDid).toBe(recipientDid);
        expect(entry.messageId).toBe(envelope.aad.messageId);
        expect(Object.keys(entry).toSorted()).toEqual(
          Object.keys(TrafficEntry.fields)
            .filter((key) => key !== "body")
            .toSorted()
        );
      }
    })
);

it.effect.prop(
  "signed plaintext reaches Traffic with its body and forged plaintext is refused at admission",
  [Arbitrary.schema(Schema.String)],
  ([text]) =>
    Effect.gen(function* plaintextTraffic() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const { sql, layer } = yield* testStore;

      const sender = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(unleasedSender),
            Layer.provide(layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(Layer.succeed(Caller, { did: senderDid }))
          )
        )
      );

      const clear = {
        ...payload(),
        body: new TextEncoder().encode(text),
        suite: plaintextSuite,
      };

      const envelope = yield* seal({
        payload: clear,
        recipientKey: sample.keys.recipient.publicKey,
        recipientKeyId: `${recipientDid}#encryption`,
        signingKey: sample.keys.sender.privateKey,
        signingKeyId: `${senderDid}#atproto`,
      });

      const signed = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SignedMessage)
      )(yield* canonicalDecode(envelope.ciphertext));

      const forged = {
        ...envelope,
        aad: payload("3m7x2ka4xv22b").aad,
        ciphertext: canonical({
          ...signed,
          canonicalSigningBytes: signingBytes({
            ...clear,
            aad: payload("3m7x2ka4xv22b").aad,
            body: new TextEncoder().encode(`${text}!`),
          }),
        }),
      };

      expect(
        Exit.isFailure(
          yield* sender.send({ envelope: forged }).pipe(Effect.exit)
        )
      ).toBe(true);

      yield* sender.send({ envelope });
      const entries = pendingTraffic(sql);
      expect(entries.map((entry) => entry.body)).toEqual([
        new TextDecoder().decode(clear.body),
      ]);
    })
);
