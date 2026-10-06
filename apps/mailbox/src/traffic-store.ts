import * as Defs from "@rat-king/lexicon/defs";
import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import { DateTime, Effect, Schema } from "effect";

import { failure } from "./failure.ts";
import type { Sql } from "./sqlite.ts";
import type { Event, Transaction } from "./store.ts";

export const trafficDid = "did:web:rat-king-traffic.internal.invalid";

export const TrafficEntry = Schema.Struct(Traffic.Entry.schema.fields);

export type TrafficEntryValue = typeof TrafficEntry.Type;

const Row = Schema.Struct({ value: Schema.String });

const Sequence = Schema.Struct({ seq: Schema.Int });

export const trafficTables = (sql: Sql) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS traffic_outbox (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS traffic (seq INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, recipient_seq INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(recipient,recipient_seq))"
  );
};

export const projectTraffic = (tx: Transaction, event: Event) => {
  if (
    !Schema.is(Defs.MessageEvent)(event) &&
    !Schema.is(Defs.ReceiptEvent)(event)
  ) {
    throw failure("MailboxUnavailable", 503, "Unknown mailbox event");
  }

  const { receipt } = event;
  const message = tx.get(receipt.message.senderDid, receipt.message.messageId);

  if (!message) {
    throw failure("MailboxUnavailable", 503, "Missing traffic message");
  }

  return Schema.decodeUnknownSync(TrafficEntry)({
    ciphertextSize: message.envelope.ciphertext.length,
    messageId: receipt.message.messageId,
    recipientDid: receipt.recipientDid,
    recipientSeq: event.seq,
    senderDid: receipt.message.senderDid,
    seq: event.seq,
    state: receipt.state,
    time: DateTime.formatIso(Effect.runSync(DateTime.now)),
  });
};

export const pendingTraffic = (sql: Sql) =>
  Array.from(
    sql.exec("SELECT value FROM traffic_outbox ORDER BY seq LIMIT 100"),
    (row) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(TrafficEntry))(
        Schema.decodeUnknownSync(Row)(row).value
      )
  );

export const appendTraffic = (
  sql: Sql,
  entries: readonly TrafficEntryValue[]
) => {
  sql.transaction(() => {
    for (const entry of entries) {
      sql.exec(
        "INSERT OR IGNORE INTO traffic (recipient,recipient_seq,value) VALUES (?,?,?)",
        entry.recipientDid,
        entry.recipientSeq,
        JSON.stringify(entry)
      );
    }
  });
};

export const trafficWatermark = (sql: Sql) => {
  const [row] = [
    ...sql.exec("SELECT COALESCE(MAX(seq),0) AS seq FROM traffic"),
  ];

  return Schema.decodeUnknownSync(Sequence)(row).seq;
};

export const listTraffic = (
  sql: Sql,
  params: Traffic.ParamsValue
): Traffic.OutputValue => {
  const cursor = params.cursor ?? "0";

  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(cursor) ||
    !Number.isSafeInteger(Number(cursor)) ||
    Number(cursor) > trafficWatermark(sql)
  ) {
    throw failure("InvalidCursor");
  }

  const events = Array.from(
    sql.exec(
      "SELECT seq,value FROM traffic WHERE seq > ? ORDER BY seq LIMIT ?",
      Number(cursor),
      params.limit ?? 50
    ),
    (row) => {
      const { value } = Schema.decodeUnknownSync(Row)(row);
      const { seq } = Schema.decodeUnknownSync(Sequence)(row);

      return {
        ...Schema.decodeUnknownSync(Schema.fromJsonString(TrafficEntry))(value),
        seq,
      };
    }
  );

  return { cursor: String(events.at(-1)?.seq ?? Number(cursor)), events };
};

export const trafficPermission = (
  issuer: string,
  operators: readonly string[],
  observers: readonly string[]
) => {
  if (!operators.includes(issuer) && !observers.includes(issuer)) {
    throw failure("Forbidden", 403);
  }
};

export const observerOnly = (
  issuer: string,
  operators: readonly string[],
  observers: readonly string[]
) => observers.includes(issuer) && !operators.includes(issuer);
