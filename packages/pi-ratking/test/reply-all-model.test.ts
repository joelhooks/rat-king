/* oxlint-disable typescript/promise-function-async -- fast-check model command Promise boundary. */
import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { replyRecipients, Threads, threadsLayer } from "../src/threads.ts";

const Name = Schema.Literals(["alice", "bob", "carol", "desk"]);

const Step = Schema.Struct({
  cc: Schema.Array(Name),
  from: Name,
  replyAll: Schema.Boolean,
  root: Schema.Literals(["root-a", "root-b"]),
  self: Name,
  to: Name,
});

interface Model {
  threads: Map<string, { sender: string; recipients: Set<string> }>;
}

it.effect.prop(
  "stored threads drive reply-all recipient sets, with deduplication, self-exclusion and sender-only opt-out",
  [Schema.Array(Step)],
  ([steps]) =>
    Effect.gen(function* replyAllModel() {
      const threads = yield* Threads;
      const context = yield* Effect.context();

      const command = (
        step: typeof Step.Type
      ): AsyncCommand<Model, object> => ({
        check: () => true,
        run: (model) => {
          const operation = Effect.gen(function* runCommand() {
            yield* threads.remember({
              body: "reply",
              cc: step.cc.length > 0,
              ccNames: step.cc,
              did: `did:web:${step.from}.example.invalid`,
              from: step.from,
              id: step.root,
              kind: "reply",
              label: Option.none(),
              replyTo: Option.some(step.root),
              summary: Option.none(),
              thread: step.root,
              to: step.to,
              verified: true,
            });
            model.threads.set(step.root, {
              recipients: new Set([step.from, step.to, ...step.cc]),
              sender: step.from,
            });

            for (const [id, known] of model.threads) {
              const stored = yield* threads.lookup(id);
              expect(Option.isSome(stored)).toBe(true);

              if (Option.isNone(stored)) {
                return;
              }

              const expected = step.replyAll
                ? new Set(known.recipients)
                : new Set([known.sender]);

              expected.delete(step.self);

              const actual = replyRecipients(
                stored.value,
                step.self,
                step.replyAll
              );

              expect(new Set(actual)).toEqual(expected);
              expect(actual.length).toBe(expected.size);
              expect(actual).not.toContain(step.self);
              expect(stored.value.thread).toBe(id);
            }
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check reuses the test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(step),
      });

      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({ model: { threads: new Map() }, real: {} }),
          steps.map(command)
        )
      );
    }).pipe(Effect.provide(threadsLayer)),
  { arbitrary: { runs: 150 } }
);
