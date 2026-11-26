/* oxlint-disable typescript/promise-function-async -- This provider fixture returns the transaction completion Promise. */
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vitest";

import { pendingNameState, standingState } from "../src/cell-name-state.ts";
import { sqliteStore } from "../src/sqlite.ts";
import { MailboxStore } from "../src/store.ts";
import { testStoreFor } from "./helpers.ts";

it.effect(
  "an alarm write that fails inside storage rolls back standing and its outbox together",
  () =>
    Effect.gen(function* test() {
      const did = "did:web:reader.example.invalid";
      const { sql } = yield* testStoreFor(did);
      let committed = 0;
      let wasStaged = false;

      const layer = sqliteStore(
        sql,
        did,
        () => {
          committed += 1;
        },
        Effect.void,
        false,
        {
          transaction: (operation, staged) => {
            try {
              return Promise.resolve(
                sql.transaction(() => {
                  operation();
                  wasStaged = staged();
                  throw new Error("Alarm write failed before commit");
                })
              );
            } catch (error) {
              return Promise.reject(
                new Error("Standing transaction rejected", { cause: error })
              );
            }
          },
        }
      );

      const store = yield* MailboxStore.pipe(Effect.provide(layer));

      const failed = yield* store
        .standingTransaction(100, (tx) => {
          tx.setRetirement({ by: did, name: "reader", retiredAt: 100 });
        })
        .pipe(Effect.result);

      expect(Result.isFailure(failed)).toBe(true);
      expect(committed).toBe(0);
      expect(wasStaged).toBe(true);
      expect(pendingNameState(sql)).toBeUndefined();
      const state = yield* store.transaction((tx) => standingState(sql, tx));
      expect(state.version).toBe(0);
      expect(state.retirement).toBeNull();
    }).pipe(Effect.scoped)
);
