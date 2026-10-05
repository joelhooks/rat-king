/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Upstream SQLite Promise transaction adapter. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- In-memory Node database and upstream Promise boundary.
import { DatabaseSync } from "node:sqlite";

import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { piDurableLayer } from "../src/pi-durable.ts";
import { AgentHarness, HarnessFailure, Input, RequestId } from "../src/port.ts";
import { durableSqlite } from "../src/sqlite.ts";

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () =>
      new HarnessFailure({
        operation: "test",
        reason: "Model switch fixture failed",
      }),
    try: run,
  });

it.effect(
  "idle hosted model switch persists the new model and clears imported history",
  () =>
    Effect.gen(function* modelSwitch() {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (owned) =>
          Effect.sync(() => {
            owned.close();
          })
      );

      const makeExecutor = () =>
        durableSqlite({
          sql: {
            exec: (query, ...values) =>
              db
                .prepare(query)
                .all(
                  ...values.map((value) =>
                    value instanceof ArrayBuffer ? new Uint8Array(value) : value
                  )
                ),
          },
          transaction: async (operation) => {
            db.exec("BEGIN");

            try {
              const result = await operation();
              db.exec("COMMIT");

              return result;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
        });

      const contexts: string[] = [];
      const models = createModels();

      for (const id of ["first", "second"]) {
        const faux = fauxProvider({ api: "faux" });
        faux.setResponses([fauxAssistantMessage(`${id} answer`)]);
        models.setProvider(
          createProvider({
            api: {
              stream: (model, context, options) => {
                contexts.push(JSON.stringify(context.messages));

                return faux.provider.stream(model, context, options);
              },
              streamSimple: (model, context, options) => {
                contexts.push(JSON.stringify(context.messages));

                return faux.provider.streamSimple(model, context, options);
              },
            },
            auth: faux.provider.auth,
            id,
            models: faux.provider
              .getModels()
              .map((model) => ({ ...model, provider: id })),
            name: id,
          })
        );
      }

      for (const provider of ["first", "second"]) {
        const storage = yield* io(() => SqliteStorage.open(makeExecutor()));

        const answer = yield* Effect.gen(function* turn() {
          const harness = yield* AgentHarness;

          const submission = yield* harness.submit(
            Input.make({
              content: `${provider} question`,
              requestId: RequestId.make(`${provider}/question`),
            })
          );

          return yield* harness.wait(submission);
        }).pipe(
          Effect.provide(
            piDurableLayer(
              storage,
              { models, registry: createRegistry() },
              { modelId: "faux-1", provider },
              { thinkingLevel: "off" },
              true
            )
          ),
          Effect.scoped
        );

        expect(answer._tag).toBe("Done");
        expect(answer).toMatchObject({ answer: `${provider} answer` });
      }

      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toContain("first question");
      expect(contexts[1]).toContain("second question");
      expect(contexts[1]).not.toContain("first question");
      expect(contexts[1]).not.toContain("first answer");
    })
);
