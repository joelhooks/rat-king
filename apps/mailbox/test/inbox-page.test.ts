import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Page from "@rat-king/lexicon/mailbox.listPage";
import type * as Mark from "@rat-king/lexicon/mailbox.markRead";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import {
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import { listPage, markRead } from "../src/inbox-page.ts";
import { Caller, handlersLayer } from "../src/mailbox.ts";
import { MailboxStore } from "../src/store.ts";
import { tid } from "../src/tid.ts";
import { testStore, unleasedSender } from "./helpers.ts";

const operator = "did:web:operator.invalid";

const seed = Effect.fn("Test.admissions")(function* seed(count: number) {
  const { envelope } = yield* sealed();
  const store = yield* MailboxStore;

  yield* store.transaction((tx) => {
    for (let index = 1; index <= count; index += 1) {
      const seq = tx.watermark() + 1;
      const message = { messageId: tid(1_800_000_000_000 + seq, 0), senderDid };

      const copy = Schema.decodeUnknownSync(
        Schema.toType(Defs.EncryptedEnvelope)
      )({ ...envelope, aad: { ...envelope.aad, ...message } });

      const receipt = Schema.decodeUnknownSync(Defs.Receipt)({
        message,
        recipientDid,
        seq,
        state: "accepted",
      });

      tx.append({
        $type: "sh.mschf.ratking.defs#messageEvent",
        envelope: copy,
        receipt,
        seq,
      });
      tx.put({
        admission: receipt,
        canonicalBytes: "fixture",
        current: receipt,
        envelope: copy,
      });
    }
  });
});

const domain = Effect.fn("Test.inbox")(function* domain() {
  const storage = yield* testStore;

  const params = yield* Schema.decodeUnknownEffect(Page.Params)({
    recipientDid,
  });

  const list = (query: Page.ParamsValue, issuer = recipientDid) =>
    listPage(query, issuer).pipe(Effect.provide(storage.layer));

  const mark = (input: Mark.InputValue, issuer = operator) =>
    markRead(input, issuer, [operator]).pipe(Effect.provide(storage.layer));

  return { list, mark, params, storage };
});

it.effect(
  "233-message cold-open fixture fetches 50 messages instead of all 233",
  () =>
    Effect.gen(function* measure() {
      const { list, params, storage } = yield* domain();

      yield* seed(233).pipe(Effect.provide(storage.layer));

      const { list: legacy } = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(storage.layer),
            Layer.provide(unleasedSender),
            Layer.provide(staticResolver([])),
            Layer.provide(Layer.succeed(Caller, { did: recipientDid }))
          )
        )
      );

      let cursor: string | undefined;
      let legacyMessages = 0;
      let legacyRequests = 0;

      do {
        const batch = yield* legacy({
          recipientDid: params.recipientDid,
          ...(cursor === undefined ? undefined : { cursor }),
        });

        ({ cursor } = batch);
        legacyRequests += 1;
        legacyMessages += batch.events.length;
      } while (cursor !== undefined);

      const newest = yield* list(params);
      const reopen = yield* list({ ...params, afterSeq: newest.latestSeq });

      expect({
        legacyMessages,
        legacyRequests,
        newestMessages: newest.messages?.length,
        reopenedEvents: reopen.events.length,
      }).toEqual({
        legacyMessages: 233,
        legacyRequests: 5,
        newestMessages: 50,
        reopenedEvents: 0,
      });
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "older pages stay exclusive while an operator mark-read only changes custody through the requested admission seq",
  {
    cutoff: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 })),
    limit: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
  },
  ({ cutoff, limit }) =>
    Effect.gen(function* pageTransitions() {
      const { list, mark, params, storage } = yield* domain();
      const count = 15;
      const input = { recipientDid: params.recipientDid, upToSeq: cutoff };

      yield* seed(count).pipe(Effect.provide(storage.layer));

      const newest = yield* list({ ...params, limit });

      expect(newest.latestSeq).toBe(count);
      expect(newest.messages?.map(({ admissionSeq }) => admissionSeq)).toEqual(
        Array.from({ length: limit }, (_, index) => count - index)
      );
      expect((yield* list(params, operator).pipe(Effect.flip)).error).toBe(
        "Forbidden"
      );
      expect((yield* mark(input, recipientDid).pipe(Effect.flip)).error).toBe(
        "Forbidden"
      );
      expect(
        (yield* mark({ ...input, upToSeq: count + 1 }).pipe(Effect.flip)).error
      ).toBe("InvalidCursor");
      expect(yield* mark(input)).toEqual({ marked: cutoff, more: false });
      expect(yield* mark(input)).toEqual({ marked: 0, more: false });

      let beforeSeq = newest.nextBeforeSeq;
      const older = [];

      while (beforeSeq !== undefined) {
        const page = yield* list({ ...params, beforeSeq, limit });
        const messages = page.messages ?? [];

        older.push(...messages);
        beforeSeq = page.nextBeforeSeq;

        expect(messages.length).toBeGreaterThan(0);
      }

      expect(
        older.map(({ admissionSeq, receipt }) => ({
          admissionSeq,
          state: receipt.state,
        }))
      ).toEqual(
        Array.from({ length: count - limit }, (_, index) => {
          const admissionSeq = count - limit - index;

          return {
            admissionSeq,
            state: admissionSeq <= cutoff ? "acked" : "accepted",
          };
        })
      );

      let afterSeq = newest.latestSeq;
      const changes: number[] = [];

      for (;;) {
        const page = yield* list({ ...params, afterSeq, limit });

        expect(page.messages).toBeUndefined();
        changes.push(
          ...page.events.map(({ seq }) =>
            Schema.decodeUnknownSync(Schema.Int)(seq)
          )
        );

        if (page.nextAfterSeq === undefined) {
          expect(page.latestSeq).toBe(count + cutoff);
          break;
        }

        afterSeq = page.nextAfterSeq;
      }

      expect(changes).toEqual(
        Array.from({ length: cutoff }, (_, index) => count + index + 1)
      );
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 20 } }
);
