import { canonical, plaintext, supported } from "@rat-king/envelope/canonical";
import { EnvelopeFailure } from "@rat-king/envelope/failure";
import { openPlaintext } from "@rat-king/envelope/signed";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect";

import { AttentionDirectory, delegates } from "./attention-directory.ts";
import { attentionHandlers } from "./attention.ts";
import { base64url, DidResolver, Document } from "./auth.ts";
import { Caller } from "./caller.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { DelegationTransport, prepareDelegation } from "./delegation.ts";
import { failure } from "./failure.ts";
import { LeaseAuthority, leaseLayer, validLease } from "./lease.ts";
import type { MailboxPolicy } from "./lease.ts";
import { advance } from "./lifecycle.ts";
import type { DeliveryCommand } from "./lifecycle.ts";
import { refuseRetired } from "./retirement.ts";
import { SenderFence } from "./sender-fence.ts";
import { MailboxStore } from "./store.ts";
import type { Message, Transaction } from "./store.ts";

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
  now: number,
  detail?: string
) => {
  const { state } = message.current;

  if (state === "delivered" && command === "inject") {
    return message.current;
  }

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

  const receipt = Schema.decodeUnknownSync(Defs.Receipt)({
    ...message.current,
    recordedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    seq,
    state: next,
  });

  if (detail !== undefined) {
    Object.assign(receipt, { detail });
  }

  tx.append({ $type: "sh.mschf.ratking.defs#receiptEvent", receipt, seq });
  tx.put({ ...message, current: receipt });

  return receipt;
};

const findMessage = (tx: Transaction, sender: string, messageId: string) => {
  const message = tx.get(sender, messageId);

  if (!message) {
    throw failure("MessageNotFound", 404);
  }

  return message;
};

const pastExpiry = (message: Message, now: number) =>
  message.envelope.aad.expiresAt !== undefined &&
  Date.parse(message.envelope.aad.expiresAt) <= now;

const expiryDue = (message: Message, now: number) =>
  pastExpiry(message, now) &&
  Defs.isDeliveryStateKnown(message.current.state) &&
  advance(message.current.state, "expire") === "expired";

export const deliverMessage = (
  tx: Transaction,
  sender: string,
  messageId: string,
  now: number
) => {
  let message = findMessage(tx, sender, messageId);

  if (
    message.current.state === "expired" ||
    message.current.state === "acked"
  ) {
    return message.current;
  }

  if (expiryDue(message, now)) {
    return transitionMessage(tx, message, "expire", now, "Expired message");
  }

  if (pastExpiry(message, now)) {
    throw failure("InvalidTransition", 409, "Expired message");
  }

  if (message.current.state === "accepted") {
    transitionMessage(tx, message, "queue", now);
    message = findMessage(tx, sender, messageId);
  }

  return transitionMessage(tx, message, "inject", now);
};

export const storeDocument = (
  tx: Transaction,
  staticDocuments: readonly Defs.DidDocumentValue[],
  document: Defs.DidDocumentValue
) => {
  if (document.id !== tx.recipient()) {
    throw failure("Forbidden", 403);
  }

  const existing =
    staticDocuments.find((candidate) => candidate.id === document.id) ??
    tx.document();

  if (existing === undefined) {
    tx.setDocument(document);
  } else if (
    base64url(canonical(existing)) !== base64url(canonical(document))
  ) {
    throw failure("DocumentConflict", 409);
  }
};

export const mailboxHandlers = (policy: MailboxPolicy) =>
  Layer.effect(
    MailboxHandlers,
    Effect.gen(function* handlersLayer() {
      const store = yield* MailboxStore;
      const caller = yield* Caller;
      const resolver = yield* DidResolver;
      const senderFence = yield* SenderFence;
      const leases = yield* LeaseAuthority;

      const attention = yield* attentionHandlers;
      const directory = yield* Effect.serviceOption(AttentionDirectory);
      const transport = yield* Effect.serviceOption(DelegationTransport);

      return MailboxHandlers.of({
        ...attention,
        ack: Effect.fn("Mailbox.ack")(function* ack(input) {
          if (caller.did !== input.recipientDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const now = yield* Clock.currentTimeMillis;

          return yield* store.transaction((tx) => {
            if (tx.recipient() !== input.recipientDid) {
              throw failure("Forbidden", 403);
            }

            validLease(tx, input, now);

            const message = findMessage(
              tx,
              input.message.senderDid,
              input.message.messageId
            );

            if (message.current.state === "acked") {
              return { receipt: message.current };
            }

            if (message.current.state === "expired") {
              return { receipt: message.current };
            }

            if (expiryDue(message, now)) {
              return {
                receipt: transitionMessage(
                  tx,
                  message,
                  "expire",
                  now,
                  "Expired message"
                ),
              };
            }

            if (pastExpiry(message, now)) {
              throw failure("InvalidTransition", 409, "Expired message");
            }

            return { receipt: transitionMessage(tx, message, "ack", now) };
          });
        }),
        acquireLease: Effect.fn("Mailbox.acquireLease")(
          function* acquireLease(input) {
            if (caller.did !== input.did) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            return { lease: yield* leases.acquire(input) };
          }
        ),
        deliver: Effect.fn("Mailbox.deliver")(function* deliver(input) {
          if (caller.did !== input.recipientDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const now = yield* Clock.currentTimeMillis;

          return yield* store.transaction((tx) => {
            if (tx.recipient() !== input.recipientDid) {
              throw failure("Forbidden", 403);
            }

            validLease(tx, input, now);

            return {
              receipt: deliverMessage(
                tx,
                input.message.senderDid,
                input.message.messageId,
                now
              ),
            };
          });
        }),
        list: Effect.fn("Mailbox.list")(function* list(params) {
          if (caller.did !== params.recipientDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const afterSeq = params.afterSeq ?? 0;
          const limit = params.limit ?? 50;
          const { cursor: token, ...query } = params;

          const fingerprint = base64url(
            canonical({ ...query, afterSeq, limit })
          );

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

            return {
              cursor: nextCursor,
              events,
              throughSeq: cursor.throughSeq,
            };
          }

          return { events, throughSeq: cursor.throughSeq };
        }),
        putDidDocument: Effect.fn("Mailbox.putDidDocument")(
          function* putDidDocument(input) {
            if (!policy.operators.includes(caller.did)) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            yield* Schema.decodeUnknownEffect(Document)(input.document).pipe(
              Effect.mapError(() => failure("InvalidRequest"))
            );

            return yield* store.transaction((tx) => {
              storeDocument(tx, policy.staticDocuments, input.document);

              return { did: input.document.id };
            });
          }
        ),
        releaseLease: Effect.fn("Mailbox.releaseLease")(
          function* releaseLease(input) {
            if (caller.did !== input.did) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            return yield* leases.release(input);
          }
        ),
        renewLease: Effect.fn("Mailbox.renewLease")(
          function* renewLease(input) {
            if (caller.did !== input.did) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            return { lease: yield* leases.renew(input) };
          }
        ),
        resolveLease: Effect.fn("Mailbox.resolveLease")(
          function* resolveLease(input) {
            if (
              caller.did !== input.did &&
              !policy.resolvers.includes(caller.did)
            ) {
              return yield* Effect.fail(failure("Forbidden", 403));
            }

            return { lease: yield* leases.resolve(input.did) };
          }
        ),
        send: Effect.fn("Mailbox.send")(function* send(input) {
          const { envelope } = input;

          if (caller.did !== envelope.aad.senderDid) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          yield* senderFence.check(caller.did, input);

          if (!supported(envelope)) {
            return yield* Effect.fail(failure("UnsupportedEnvelope"));
          }

          yield* resolver.resolve(
            envelope.aad.recipientDid,
            envelope.aad.recipientKeyId,
            "keyAgreement"
          );

          let signed: Defs.SigningPayloadValue | undefined;

          if (plaintext(envelope)) {
            signed = yield* openPlaintext(envelope, (did, keyId) =>
              resolver.resolve(did, keyId, "authentication").pipe(
                Effect.mapError(
                  () =>
                    new EnvelopeFailure({
                      reason: "Unauthorized sender signing key",
                    })
                )
              )
            ).pipe(
              Effect.mapError(() =>
                failure("InvalidRequest", 400, "Invalid plaintext signature")
              )
            );
          }

          if (policy.delegation === true && Option.isNone(transport)) {
            return yield* failure("MailboxUnavailable", 503);
          }

          const bytes = base64url(canonical(envelope));

          const replay =
            policy.delegation === true
              ? yield* store.transaction((tx) =>
                  tx.get(envelope.aad.senderDid, envelope.aad.messageId)
                )
              : undefined;

          if (replay !== undefined) {
            if (replay.canonicalBytes !== bytes) {
              return yield* failure("Conflict", 409);
            }

            return { receipt: replay.admission };
          }

          const plan =
            policy.delegation === true
              ? yield* Option.match(directory, {
                  onNone: () => Effect.fail(failure("MailboxUnavailable", 503)),
                  onSome: (port) =>
                    prepareDelegation(
                      envelope,
                      signed,
                      input.critical,
                      policy.operators
                    ).pipe(
                      Effect.provideService(MailboxStore, store),
                      Effect.provideService(AttentionDirectory, port),
                      Effect.catchTag("XrpcFailure", () =>
                        Effect.succeed(Option.none())
                      )
                    ),
                })
              : Option.none();

          const now = yield* Clock.currentTimeMillis;

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
                throw failure("Conflict", 409);
              }

              return { receipt: existing.admission };
            }

            refuseRetired(tx);

            if (
              envelope.aad.expiresAt &&
              Date.parse(envelope.aad.expiresAt) <= now
            ) {
              throw failure("InvalidRequest", 400, "Envelope expired");
            }

            const seq = nextSeq(tx);

            const receipt = Schema.decodeUnknownSync(Defs.Receipt)({
              message: {
                messageId: envelope.aad.messageId,
                senderDid: envelope.aad.senderDid,
              },
              recipientDid: envelope.aad.recipientDid,
              recordedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              seq,
              state: "accepted",
            });

            const status =
              policy.delegation === true ? tx.attentionStatus() : undefined;

            const route =
              Option.isSome(plan) &&
              status !== undefined &&
              status.delegate === plan.value.delegateName &&
              delegates(status, now)
                ? plan.value
                : undefined;

            if (route !== undefined) {
              const delegated = { to: route.delegateName };

              if (status?.until !== undefined) {
                Object.assign(delegated, { until: status.until });
              }

              Object.assign(receipt, {
                delegated,
                delegatedTo: route.delegateName,
                woke: false,
              });
            }

            if (input.woke !== undefined && route === undefined) {
              Object.assign(receipt, { woke: input.woke });
            }

            if (input.wakeReason !== undefined) {
              Object.assign(receipt, { wakeReason: input.wakeReason });
            }

            if (input.resolvedFrom !== undefined) {
              Object.assign(receipt, { resolvedFrom: input.resolvedFrom });
            }

            tx.append({
              $type: "sh.mschf.ratking.defs#messageEvent",
              envelope,
              receipt,
              seq,
            });

            const message: Message = {
              admission: receipt,
              canonicalBytes: bytes,
              current: receipt,
              envelope,
            };

            if (input.critical !== undefined) {
              Object.assign(message, { critical: input.critical });
            }

            if (route !== undefined) {
              Object.assign(message, { delegationPending: route });
            }

            tx.put(message);

            return { receipt };
          });
        }),
      });
    })
  ).pipe(Layer.provide(leaseLayer));

export const handlersLayer = mailboxHandlers({
  operators: [],
  resolvers: [],
  staticDocuments: [],
});

export { Caller } from "./caller.ts";

export { LeaseAuthority, leaseLayer } from "./lease.ts";
