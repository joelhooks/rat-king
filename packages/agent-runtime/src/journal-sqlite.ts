/* oxlint-disable typescript/promise-function-async -- pi-durable SQLite exposes a Promise facade. */
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { Clock, Effect, Schema } from "effect";

import { AgentJournal, Journal } from "./agent-journal.ts";
import { HarnessFailure } from "./port.ts";

const Row = Schema.Struct({ value: Schema.String });

const sql = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () =>
      new HarnessFailure({ operation, reason: "Agent journal storage failed" }),
    try: run,
  });

export const journalSqlite = (database: SqliteDatabase) =>
  AgentJournal.of({
    read: Effect.fn("AgentJournal.read")(
      function* read(id) {
        const row = yield* sql("journal.read", () =>
          database.get("SELECT value FROM agent_loop WHERE request_id=?", id)
        );

        if (row === undefined) {
          return row;
        }

        const parsed = yield* Schema.decodeUnknownEffect(Row)(row);

        return yield* Schema.decodeEffect(Schema.fromJsonString(Journal))(
          parsed.value
        );
      },
      Effect.mapError(
        () =>
          new HarnessFailure({
            operation: "journal.read",
            reason: "Invalid loop checkpoint",
          })
      )
    ),
    replyId: Effect.fn("AgentJournal.replyId")(
      function* replyId() {
        const row = yield* sql("journal.replyId", () =>
          database.get("SELECT value FROM agent_loop_meta WHERE key='tid'")
        );

        const previous =
          row === undefined
            ? 0n
            : BigInt((yield* Schema.decodeUnknownEffect(Row)(row)).value);

        const now = BigInt(yield* Clock.currentTimeMillis) * 1000n;
        const next = now > previous ? now : previous + 1n;

        yield* sql("journal.replyId", () =>
          database.run(
            "INSERT INTO agent_loop_meta VALUES ('tid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            String(next)
          )
        );

        let number = next * 1024n;
        let text = "";

        for (let index = 0; index < 13; index += 1) {
          text =
            ("234567abcdefghijklmnopqrstuvwxyz"[Number(number % 32n)] ?? "2") +
            text;
          number /= 32n;
        }

        return text;
      },
      Effect.mapError(
        () =>
          new HarnessFailure({
            operation: "journal.replyId",
            reason: "Cannot reserve reply TID",
          })
      )
    ),
    write: Effect.fn("AgentJournal.write")(
      function* write(id, value) {
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Journal)
        )(value);

        yield* sql("journal.write", () =>
          database.run(
            "INSERT INTO agent_loop VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET value=excluded.value",
            id,
            encoded
          )
        );
      },
      Effect.mapError(
        () =>
          new HarnessFailure({
            operation: "journal.write",
            reason: "Cannot commit loop checkpoint",
          })
      )
    ),
  });
