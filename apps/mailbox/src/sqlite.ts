import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { Effect, Layer, Schema } from "effect";

import { base64url, unbase64url } from "./auth.ts";
import { Lease, MailboxStore, storageOperation } from "./store.ts";
import type { Event, LeaseValue, Message, Transaction } from "./store.ts";
import { projectTraffic, trafficTables } from "./traffic-store.ts";

export interface Sql {
  readonly exec: (
    query: string,
    ...bindings: readonly (string | number)[]
  ) => Iterable<unknown>;
  readonly transaction: <A>(operation: () => A) => A;
}

const Row = Schema.Struct({ value: Schema.String });

const NumberRow = Schema.Struct({
  value: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  ),
});

const Persisted = Schema.Struct({
  admission: Defs.Receipt,
  canonicalBytes: Schema.String,
  current: Defs.Receipt,
  envelope: Defs.EncryptedEnvelope,
});

const EventSchema = List.Output;

const firstValue = (
  sql: Sql,
  query: string,
  ...bindings: readonly (string | number)[]
) => {
  const [row] = [...sql.exec(query, ...bindings)];

  return row === undefined
    ? undefined
    : Schema.decodeUnknownSync(Row)(row).value;
};

export const sqliteStore = (
  sql: Sql,
  recipient: string,
  committed?: (events: readonly Event[], lease: LeaseValue | undefined) => void,
  beforeTransaction: Effect.Effect<void> = Effect.void
) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS messages (sender TEXT NOT NULL, tid TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(sender, tid))"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY CHECK(seq > 0 AND seq <= 9007199254740991), value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS lease (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL)"
  );
  sql.exec(
    "INSERT OR IGNORE INTO metadata (key,value) VALUES ('recipient',?)",
    recipient
  );
  sql.exec(
    "INSERT OR IGNORE INTO metadata (key,value) VALUES ('cursorSecret',?)",
    base64url(crypto.getRandomValues(new Uint8Array(32)))
  );

  trafficTables(sql);

  const transaction: Transaction = {
    append: (event: Event) => {
      sql.exec(
        "INSERT INTO events (seq,value) VALUES (?,?)",
        Schema.decodeUnknownSync(NumberRow)({ value: event.seq }).value,
        JSON.stringify(
          Schema.encodeSync(EventSchema)({ events: [event], throughSeq: 0 })
            .events[0]
        )
      );
    },
    cursorSecret: () =>
      unbase64url(
        firstValue(
          sql,
          "SELECT value FROM metadata WHERE key='cursorSecret'"
        ) ?? ""
      ),
    document: () => {
      const value = firstValue(
        sql,
        "SELECT value FROM metadata WHERE key='didDocument'"
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Defs.DidDocument)(JSON.parse(value));
    },
    events: (after, through, limit) =>
      Array.from(
        sql.exec(
          "SELECT value FROM events WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
          after,
          through,
          limit
        ),
        (row) => {
          const [event] = Schema.decodeUnknownSync(EventSchema)({
            events: [JSON.parse(Schema.decodeUnknownSync(Row)(row).value)],
            throughSeq: 0,
          }).events;

          if (!event) {
            throw new Error("Persisted event missing");
          }

          return event;
        }
      ),
    get: (sender, tid) => {
      const value = firstValue(
        sql,
        "SELECT value FROM messages WHERE sender=? AND tid=?",
        sender,
        tid
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Persisted)(JSON.parse(value));
    },
    lease: () => {
      const value = firstValue(
        sql,
        "SELECT value FROM lease WHERE singleton=1"
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Lease)(JSON.parse(value));
    },
    put: (message: Message) => {
      sql.exec(
        "INSERT INTO messages (sender,tid,value) VALUES (?,?,?) ON CONFLICT(sender,tid) DO UPDATE SET value=excluded.value",
        message.envelope.aad.senderDid,
        message.envelope.aad.messageId,
        JSON.stringify(Schema.encodeSync(Persisted)(message))
      );
    },
    recipient: () =>
      firstValue(sql, "SELECT value FROM metadata WHERE key='recipient'") ?? "",
    setDocument: (document) => {
      sql.exec(
        "INSERT INTO metadata (key,value) VALUES ('didDocument',?)",
        JSON.stringify(Schema.encodeSync(Defs.DidDocument)(document))
      );
    },
    setLease: (lease) => {
      sql.exec(
        "INSERT INTO lease (singleton,value) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value",
        JSON.stringify(lease)
      );
    },
    watermark: () => {
      const [row] = [
        ...sql.exec("SELECT COALESCE(MAX(seq),0) AS value FROM events"),
      ];

      return Schema.decodeUnknownSync(NumberRow)(row).value;
    },
  };

  return Layer.succeed(
    MailboxStore,
    MailboxStore.of({
      transaction: (operation) =>
        beforeTransaction.pipe(
          Effect.andThen(
            storageOperation(() => {
              const appended: Event[] = [];

              const result = sql.transaction(() => {
                const value = operation({
                  ...transaction,
                  append: (event) => {
                    transaction.append(event);
                    appended.push(event);
                  },
                });

                for (const event of appended) {
                  const entry = projectTraffic(transaction, event);
                  sql.exec(
                    "INSERT INTO traffic_outbox (seq,value) VALUES (?,?)",
                    entry.recipientSeq,
                    JSON.stringify(entry)
                  );
                }

                return value;
              });

              committed?.(appended, transaction.lease());

              return result;
            })
          )
        ),
    })
  );
};
