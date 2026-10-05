import { canonical, supported } from "@rat-king/envelope/canonical";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import { base64url, DidResolver } from "./auth.ts";
import { Caller } from "./caller.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { failure } from "./failure.ts";
import { advance } from "./lifecycle.ts";
import type { DeliveryCommand } from "./lifecycle.ts";
import { MailboxStore } from "./store.ts";
import type { LeaseValue, Message, Transaction } from "./store.ts";

const nextSeq = (tx: Transaction) => {
  const next = tx.watermark() + 1;

  if (!Number.isSafeInteger(next) || next <= 0) {
    throw failure("MailboxUnavailable", 503, "Sequence exhausted");
  }

  return next;
};

export const transitionMessage = (
  tx: Transaction,
  message: Message,
  command: DeliveryCommand,
  detail?: string
) => {
  const { state } = message.current;

  if (!Defs.isDeliveryStateKnown(state)) {
    throw failure("InvalidTransition");
  }

  const next = advance(state, command);

  if (next === state && command !== "inject") {
    throw failure("InvalidTransition");
  }

  if (next === state && state !== "delivered") {
    throw failure("InvalidTransition");
  }

  const seq = nextSeq(tx);

  const receipt: Defs.ReceiptValue = { ...message.current, seq, state: next };

  if (detail !== undefined) {
    Object.assign(receipt, { detail });
  }

  tx.append({ $type: "sh.mschf.ratking.defs#receiptEvent", receipt, seq });
  tx.put({ ...message, current: receipt });

  return receipt;
};

const validLease = (
  tx: Transaction,
  leaseId: string,
  generation: number,
  now: number
) => {
  const lease = tx.lease();

  if (
    !lease ||
    lease.leaseId !== leaseId ||
    lease.generation !== generation ||
    lease.expiresAt <= now
  ) {
    throw failure("LeaseMismatch", 409);
  }

  return lease;
};

const findMessage = (tx: Transaction, sender: string, messageId: string) => {
  const message = tx.get(sender, messageId);

  if (!message) {
    throw failure("MessageNotFound", 404);
  }

  return message;
};

export const handlersLayer = Layer.effect(
  MailboxHandlers,
  Effect.gen(function* handlersLayer() {
    const store = yield* MailboxStore;
    const caller = yield* Caller;
    const resolver = yield* DidResolver;

    return MailboxHandlers.of({
      ack: Effect.fn("Mailbox.ack")(function* ack(input) {
        if (caller.did !== input.recipientDid) {
          return yield* Effect.fail(failure("Forbidden", 403));
        }

        const now = yield* Clock.currentTimeMillis;

        return yield* store.transaction((tx) => {
          if (tx.recipient() !== input.recipientDid) {
            throw failure("Forbidden", 403);
          }

          validLease(tx, input.leaseId, input.generation, now);

          const message = findMessage(
            tx,
            input.message.senderDid,
            input.message.messageId
          );

          if (
            message.envelope.aad.expiresAt &&
            Date.parse(message.envelope.aad.expiresAt) <= now &&
            message.current.state !== "acked"
          ) {
            throw failure("InvalidTransition", 409, "Expired message");
          }

          if (message.current.state === "acked") {
            return { receipt: message.current };
          }

          return { receipt: transitionMessage(tx, message, "ack") };
        });
      }),
      acquireLease: () => Effect.fail(failure("InvalidRequest")),
      deliver: () => Effect.fail(failure("InvalidRequest")),
      list: Effect.fn("Mailbox.list")(function* list(params) {
        if (caller.did !== params.recipientDid) {
          return yield* Effect.fail(failure("Forbidden", 403));
        }

        const afterSeq = params.afterSeq ?? 0;
        const limit = params.limit ?? 50;
        const { cursor: token, ...query } = params;
        const fingerprint = base64url(canonical({ ...query, afterSeq, limit }));

        const snapshot = yield* store.transaction((tx) => {
          if (tx.recipient() !== params.recipientDid) {
            throw failure("Forbidden", 403);
          }

          if (afterSeq > tx.watermark()) {
            throw failure("InvalidCursor", 400, "Future position");
          }

          return { secret: tx.cursorSecret(), watermark: tx.watermark() };
        });

        const cursor =
          token !== undefined && token !== ""
            ? yield* decodeCursor({
                afterSeq,
                fingerprint,
                recipient: params.recipientDid,
                secret: snapshot.secret,
                token,
                watermark: snapshot.watermark,
              })
            : { lastSeq: afterSeq, throughSeq: snapshot.watermark };

        const events = yield* store.transaction((tx) =>
          tx.events(cursor.lastSeq, cursor.throughSeq, limit)
        );

        const lastSeq = events.length
          ? yield* Schema.decodeUnknownEffect(Schema.Int)(
              events.at(-1)?.seq
            ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)))
          : cursor.lastSeq;

        const more = yield* store.transaction(
          (tx) => tx.events(lastSeq, cursor.throughSeq, 1).length > 0
        );

        if (more) {
          const nextCursor = yield* encodeCursor(
            {
              fingerprint,
              lastSeq,
              recipient: params.recipientDid,
              throughSeq: cursor.throughSeq,
              version: 1,
            },
            snapshot.secret
          ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));

          return { cursor: nextCursor, events, throughSeq: cursor.throughSeq };
        }

        return { events, throughSeq: cursor.throughSeq };
      }),
      putDidDocument: () => Effect.fail(failure("InvalidRequest")),
      releaseLease: () => Effect.fail(failure("InvalidRequest")),
      renewLease: () => Effect.fail(failure("InvalidRequest")),
      resolveLease: () => Effect.fail(failure("InvalidRequest")),
      send: Effect.fn("Mailbox.send")(function* send(input) {
        const { envelope } = input;

        if (caller.did !== envelope.aad.senderDid) {
          return yield* Effect.fail(failure("Forbidden", 403));
        }

        if (!supported(envelope)) {
          return yield* Effect.fail(failure("UnsupportedEnvelope"));
        }

        yield* resolver.resolve(
          envelope.aad.recipientDid,
          envelope.aad.recipientKeyId,
          "keyAgreement"
        );
        const now = yield* Clock.currentTimeMillis;
        const bytes = base64url(canonical(envelope));

        return yield* store.transaction((tx) => {
          if (tx.recipient() !== envelope.aad.recipientDid) {
            throw failure("Forbidden", 403);
          }

          const existing = tx.get(
            envelope.aad.senderDid,
            envelope.aad.messageId
          );

          if (existing) {
            if (existing.canonicalBytes !== bytes) {
              throw failure("IdempotencyConflict", 409);
            }

            return { receipt: existing.admission };
          }

          if (
            envelope.aad.expiresAt &&
            Date.parse(envelope.aad.expiresAt) <= now
          ) {
            throw failure("InvalidRequest", 400, "Envelope expired");
          }

          const seq = nextSeq(tx);

          const receipt: Defs.ReceiptValue = {
            message: {
              messageId: envelope.aad.messageId,
              senderDid: envelope.aad.senderDid,
            },
            recipientDid: envelope.aad.recipientDid,
            seq,
            state: "accepted",
          };

          tx.append({
            $type: "sh.mschf.ratking.defs#messageEvent",
            envelope,
            receipt,
            seq,
          });
          tx.put({
            admission: receipt,
            canonicalBytes: bytes,
            current: receipt,
            envelope,
          });

          return { receipt };
        });
      }),
    });
  })
);

export interface LeaseInterface {
  readonly acquire: (
    leaseId: string,
    ttl: number
  ) => Effect.Effect<LeaseValue, XrpcFailure>;
  readonly renew: (
    leaseId: string,
    generation: number,
    ttl: number
  ) => Effect.Effect<LeaseValue, XrpcFailure>;
  readonly release: (
    leaseId: string,
    generation: number
  ) => Effect.Effect<void, XrpcFailure>;
  readonly inject: (
    sender: string,
    tid: string,
    leaseId: string,
    generation: number
  ) => Effect.Effect<Defs.ReceiptValue, XrpcFailure>;
}

export class LeaseAuthority extends Context.Service<
  LeaseAuthority,
  LeaseInterface
>()("mailbox/LeaseAuthority") {}

const expiry = (now: number, ttl: number) => {
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000) {
    throw failure("InvalidRequest");
  }

  return now + ttl;
};

export const leaseLayer = Layer.effect(
  LeaseAuthority,
  Effect.gen(function* leaseLayer() {
    const store = yield* MailboxStore;

    return LeaseAuthority.of({
      acquire: Effect.fn("Lease.acquire")(function* acquire(leaseId, ttl) {
        const now = yield* Clock.currentTimeMillis;

        return yield* store.transaction((tx) => {
          const generation = (tx.lease()?.generation ?? 0) + 1;

          if (!Number.isSafeInteger(generation)) {
            throw failure("LeaseMismatch");
          }

          const lease = { expiresAt: expiry(now, ttl), generation, leaseId };
          tx.setLease(lease);

          return lease;
        });
      }),
      inject: Effect.fn("Lease.inject")(
        function* inject(sender, tid, leaseId, generation) {
          const now = yield* Clock.currentTimeMillis;

          return yield* store.transaction((tx) => {
            validLease(tx, leaseId, generation, now);
            let message = findMessage(tx, sender, tid);

            if (
              message.envelope.aad.expiresAt &&
              Date.parse(message.envelope.aad.expiresAt) <= now
            ) {
              throw failure("InvalidTransition", 409, "Expired message");
            }

            if (message.current.state === "accepted") {
              transitionMessage(tx, message, "queue");
              message = findMessage(tx, sender, tid);
            }

            return transitionMessage(tx, message, "inject");
          });
        }
      ),
      release: Effect.fn("Lease.release")(
        function* release(leaseId, generation) {
          const now = yield* Clock.currentTimeMillis;
          yield* store.transaction((tx) => {
            const lease = validLease(tx, leaseId, generation, now);
            tx.setLease({ ...lease, expiresAt: now });
          });
        }
      ),
      renew: Effect.fn("Lease.renew")(
        function* renew(leaseId, generation, ttl) {
          const now = yield* Clock.currentTimeMillis;

          return yield* store.transaction((tx) => {
            const lease = {
              ...validLease(tx, leaseId, generation, now),
              expiresAt: expiry(now, ttl),
            };

            tx.setLease(lease);

            return lease;
          });
        }
      ),
    });
  })
);

export { Caller } from "./caller.ts";
