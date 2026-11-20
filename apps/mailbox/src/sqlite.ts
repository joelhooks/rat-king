import * as Prefs from "@rat-king/lexicon/attention.prefs";
import * as AttentionReceipt from "@rat-king/lexicon/attention.receipt";
import * as Status from "@rat-king/lexicon/attention.status";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { Effect, Layer, Schema } from "effect";

import { base64url, unbase64url } from "./auth.ts";
import { Lease, MailboxStore, Retirement, storageOperation } from "./store.ts";
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
  critical: Schema.optionalKey(Schema.Boolean),
  current: Defs.Receipt,
  delegationPending: Schema.optionalKey(
    Schema.Struct({
      copyId: Schema.String,
      delegateDid: Schema.String,
      delegateName: Schema.String,
      desk: Schema.String,
    })
  ),
  envelope: Defs.EncryptedEnvelope,
});

const MessageRow = Schema.Struct({ value: Schema.fromJsonString(Persisted) });

const readMessages = (
  sql: Sql,
  query: string,
  through: number,
  limit: number
) =>
  Array.from(
    sql.exec(query, through, limit),
    (row) => Schema.decodeUnknownSync(MessageRow)(row).value
  );

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
  beforeTransaction: Effect.Effect<void> = Effect.void,
  delegation = false
) => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS messages (sender TEXT NOT NULL, tid TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(sender, tid))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS messages_custody ON messages(json_extract(value,'$.current.state'),json_extract(value,'$.admission.seq'))"
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS messages_admission ON messages(json_extract(value,'$.admission.seq'))"
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
    admissionsThrough: (through, limit) =>
      readMessages(
        sql,
        "SELECT value FROM messages WHERE json_extract(value,'$.admission.seq') <= ? ORDER BY json_extract(value,'$.admission.seq') DESC LIMIT ?",
        through,
        limit
      ),
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
    attentionPreferences: () => {
      const value = firstValue(
        sql,
        "SELECT value FROM metadata WHERE key='attentionPreferences'"
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(Prefs.Main))(value);
    },
    attentionStatus: () => {
      const value = firstValue(
        sql,
        "SELECT value FROM metadata WHERE key='attentionStatus'"
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(Status.Main))(value);
    },
    cursorSecret: () =>
      unbase64url(
        firstValue(
          sql,
          "SELECT value FROM metadata WHERE key='cursorSecret'"
        ) ?? ""
      ),
    delivered: () =>
      Array.from(
        sql.exec(
          "SELECT value FROM messages WHERE json_extract(value,'$.current.state')='delivered' ORDER BY json_extract(value,'$.admission.seq') ASC"
        ),
        (row) =>
          Schema.decodeUnknownSync(Persisted)(
            JSON.parse(Schema.decodeUnknownSync(Row)(row).value)
          )
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
    pendingDelegations: () =>
      Array.from(
        sql.exec(
          "SELECT value FROM messages WHERE json_extract(value,'$.delegationPending') IS NOT NULL ORDER BY json_extract(value,'$.admission.seq') LIMIT 100"
        ),
        (row) =>
          Schema.decodeUnknownSync(Persisted)(
            JSON.parse(Schema.decodeUnknownSync(Row)(row).value)
          )
      ),
    put: (message: Message) => {
      sql.exec(
        "INSERT INTO messages (sender,tid,value) VALUES (?,?,?) ON CONFLICT(sender,tid) DO UPDATE SET value=excluded.value",
        message.admission.message.senderDid,
        message.admission.message.messageId,
        JSON.stringify(Schema.encodeSync(Persisted)(message))
      );
    },
    recipient: () =>
      firstValue(sql, "SELECT value FROM metadata WHERE key='recipient'") ?? "",
    retirement: () => {
      const value = firstValue(
        sql,
        "SELECT value FROM metadata WHERE key='retirement'"
      );

      return value === undefined
        ? undefined
        : Schema.decodeUnknownSync(Schema.fromJsonString(Retirement))(value);
    },
    setAttentionPreferences: (prefs) => {
      sql.exec(
        "INSERT INTO metadata (key,value) VALUES ('attentionPreferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        Schema.encodeSync(Schema.fromJsonString(Prefs.Main))(prefs)
      );
    },
    setAttentionStatus: (status) => {
      sql.exec(
        "INSERT INTO metadata (key,value) VALUES ('attentionStatus',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        Schema.encodeSync(Schema.fromJsonString(Status.Main))(status)
      );
    },
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
    setRetirement: (retirement) => {
      if (retirement === undefined) {
        sql.exec("DELETE FROM metadata WHERE key='retirement'");

        return;
      }

      sql.exec(
        "INSERT INTO metadata (key,value) VALUES ('retirement',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        Schema.encodeSync(Schema.fromJsonString(Retirement))(retirement)
      );
    },
    unreadThrough: (through, limit) =>
      readMessages(
        sql,
        "SELECT value FROM messages WHERE json_extract(value,'$.current.state') IN ('accepted','queued','delivered') AND json_extract(value,'$.admission.seq') <= ? ORDER BY json_extract(value,'$.admission.seq') ASC LIMIT ?",
        through,
        limit
      ),
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
                  if (Schema.is(AttentionReceipt.Main)(event)) {
                    continue;
                  }

                  const entry = projectTraffic(transaction, event, delegation);
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
