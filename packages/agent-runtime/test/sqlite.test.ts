/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- The upstream database transaction interface uses Promise callbacks. */
// @effect-diagnostics nodeBuiltinImport:off -- Node SQLite is a test host for the portable DO SQL facade.
// @effect-diagnostics asyncFunction:off -- Test adapter for pi-durable's async SQLite contract.
// @effect-diagnostics newPromise:off -- Deterministic Promise gates pause the upstream transaction callback.
/* oxlint-disable promise/avoid-new -- These gates expose an upstream Promise transaction without running an Effect runtime inside its callback. */
import { DatabaseSync } from "node:sqlite";

import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { durableSqlite } from "../src/sqlite.ts";

class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()(
  "DatabaseFailure",
  {
    reason: Schema.String,
  }
) {}

const uninitialized = (): never => {
  throw new Error("Gate not initialized");
};

const deferred = <A>() => {
  let complete: (value: A) => void = uninitialized;

  const promise = new Promise<A>((resolve) => {
    complete = resolve;
  });

  return {
    promise,
    resolve: (value: A) => {
      complete(value);
    },
  };
};

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new DatabaseFailure({ reason: String(cause) }),
    try: run,
  });

it.effect(
  "SQLite facade queues outside reads, rolls back and expires transaction handles",
  () =>
    Effect.gen(function* proof() {
      const host = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (owned) =>
          Effect.sync(() => {
            owned.close();
          })
      );

      const database = durableSqlite({
        sql: {
          exec: (query, ...values) =>
            host
              .prepare(query)
              .all(
                ...values.map((value) =>
                  value instanceof ArrayBuffer ? new Uint8Array(value) : value
                )
              ),
        },
        transaction: async (operation) => {
          host.exec("BEGIN");

          try {
            const result = await operation();
            host.exec("COMMIT");

            return result;
          } catch (error) {
            host.exec("ROLLBACK");
            throw error;
          }
        },
      });

      yield* io(() => database.exec("CREATE TABLE sample (value INTEGER)"));
      const entered = deferred<SqliteExecutor>();
      const release = deferred<boolean>();
      const rollback = new Error("roll back this transaction");

      const pending = database.transaction(async (tx) => {
        await tx.run("INSERT INTO sample VALUES (?)", 42);
        entered.resolve(tx);
        await release.promise;
        throw rollback;
      });

      const observed = pending.then(
        () => false,
        (error: unknown) => error === rollback
      );

      const handle = yield* io(() => entered.promise);
      const read = database.all("SELECT value FROM sample");
      yield* Effect.sync(() => {
        release.resolve(true);
      });
      expect(yield* io(() => observed)).toBe(true);
      expect(yield* io(() => read)).toEqual([]);
      expect(
        yield* io(() => handle.get("SELECT value FROM sample")).pipe(
          Effect.flip
        )
      ).toBeInstanceOf(DatabaseFailure);
      yield* io(() => database.run("INSERT INTO sample VALUES (?)", 7));
      expect(yield* io(() => database.all("SELECT value FROM sample"))).toEqual(
        [{ value: 7 }]
      );
      yield* io(() => database.close());
      expect(
        yield* io(() => database.get("SELECT value FROM sample")).pipe(
          Effect.flip
        )
      ).toBeInstanceOf(DatabaseFailure);
    })
);
