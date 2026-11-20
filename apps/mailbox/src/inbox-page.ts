import type * as ListPage from "@rat-king/lexicon/mailbox.listPage";
import type * as MarkRead from "@rat-king/lexicon/mailbox.markRead";
import { Clock, Effect, Schema } from "effect";

import { failure } from "./failure.ts";
import { transitionMessage } from "./mailbox.ts";
import { MailboxStore } from "./store.ts";
import type { Transaction } from "./store.ts";

const snapshot = (
  tx: Transaction,
  limit: number,
  through: number,
  latestSeq: number
): ListPage.OutputValue => {
  const rows = tx.admissionsThrough(through, limit + 1);

  const messages = rows
    .slice(0, limit)
    .map(({ admission, current, envelope }) => ({
      admissionSeq: admission.seq,
      envelope,
      receipt: current,
    }));

  const last = messages.at(-1);

  return rows.length > limit && last !== undefined
    ? { events: [], latestSeq, messages, nextBeforeSeq: last.admissionSeq }
    : { events: [], latestSeq, messages };
};

const incremental = (
  tx: Transaction,
  after: number,
  limit: number,
  latestSeq: number
): ListPage.OutputValue => {
  const rows = tx.events(after, latestSeq, limit + 1);
  const events = rows.slice(0, limit);
  const last = events.at(-1);

  return rows.length > limit && last !== undefined
    ? {
        events,
        latestSeq,
        nextAfterSeq: Schema.decodeUnknownSync(Schema.Int)(last.seq),
      }
    : { events, latestSeq };
};

export const listPage = Effect.fn("Mailbox.listPage")(function* listPage(
  params: ListPage.ParamsValue,
  issuer: string
) {
  if (issuer !== params.recipientDid) {
    return yield* failure("Forbidden", 403);
  }

  const { afterSeq, beforeSeq, limit = 50 } = params;

  if (afterSeq !== undefined && beforeSeq !== undefined) {
    return yield* failure("InvalidCursor");
  }

  const store = yield* MailboxStore;

  return yield* store.transaction((tx) => {
    if (tx.recipient() !== params.recipientDid) {
      throw failure("Forbidden", 403);
    }

    const latestSeq = tx.watermark();
    const through = beforeSeq === undefined ? latestSeq : beforeSeq - 1;

    if (
      through > latestSeq ||
      (afterSeq !== undefined && afterSeq > latestSeq)
    ) {
      throw failure("InvalidCursor", 400, "Future position");
    }

    return afterSeq === undefined
      ? snapshot(tx, limit, through, latestSeq)
      : incremental(tx, afterSeq, limit, latestSeq);
  });
});

const markReadLimit = 500;

export const markRead = Effect.fn("Mailbox.markRead")(function* markRead(
  input: MarkRead.InputValue,
  issuer: string,
  operators: readonly string[]
) {
  if (!operators.includes(issuer)) {
    return yield* failure("Forbidden", 403);
  }

  const store = yield* MailboxStore;
  const now = yield* Clock.currentTimeMillis;

  return yield* store.transaction((tx) => {
    if (tx.recipient() !== input.recipientDid) {
      throw failure("Forbidden", 403);
    }

    if (input.upToSeq > tx.watermark()) {
      throw failure("InvalidCursor", 400, "Future position");
    }

    const rows = tx.unreadThrough(input.upToSeq, markReadLimit + 1);
    const batch = rows.slice(0, markReadLimit);

    for (const message of batch) {
      transitionMessage(
        tx,
        message,
        "operatorRead",
        now,
        "Marked read by operator"
      );
    }

    return { marked: batch.length, more: rows.length > markReadLimit };
  });
});
