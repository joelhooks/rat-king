/* oxlint-disable typescript/promise-function-async -- fast-check AsyncCommand.run and asyncModelRun are Promise boundaries. */
import { it } from "@effect/vitest";
import { Arbitrary, Deferred, Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import type { Inbound } from "../src/payload.ts";
import { Threads, threadsLayer } from "../src/threads.ts";
import type { Reply } from "../src/threads.ts";

class ModelFailure extends Schema.TaggedError<ModelFailure>()("ModelFailure", {
  message: Schema.String,
}) {}

const Id = Schema.Literals(["m1", "m2", "m3"]);

const Peer = Schema.Literals([
  "did:web:a.example.invalid",
  "did:web:b.example.invalid",
]);

const Step = Schema.Union([
  Schema.Struct({ action: Schema.Literal("ask"), did: Peer, id: Id }),
  Schema.Struct({
    action: Schema.Literal("inbound"),
    did: Peer,
    replyTo: Schema.Option(Id),
  }),
  Schema.Struct({ action: Schema.Literal("forget"), id: Id }),
]);

interface Model {
  readonly waiting: Map<string, string>;
}

it.effect.prop(
  "a reply resolves only the ask it names, and only when it comes from the asked peer; everything else is left for injection",
  [Arbitrary.schema(Schema.Array(Step))],
  ([steps]) =>
    Effect.gen(function* threadingModel() {
      const threads = yield* Threads;
      const context = yield* Effect.context();
      const replies = new Map<string, Deferred.Deferred<Reply>>();
      let counter = 0;

      const command = (
        step: typeof Step.Type
      ): AsyncCommand<Model, undefined> => ({
        check: () => true,
        run: (model) => {
          const operation = Effect.gen(function* apply() {
            if (step.action === "ask") {
              replies.set(step.id, yield* threads.wait(step.id, step.did));
              model.waiting.set(step.id, step.did);

              return;
            }

            if (step.action === "forget") {
              yield* threads.forget(step.id);
              model.waiting.delete(step.id);

              return;
            }

            counter += 1;

            const inbound: Inbound = {
              body: `reply ${counter}`,
              cc: false,
              did: step.did,
              from: "peer",
              id: `in-${counter}`,
              kind: "reply",
              label: Option.none(),
              replyTo: step.replyTo,
              verified: true,
            };

            const expected = Option.exists(
              step.replyTo,
              (id) => model.waiting.get(id) === step.did
            );

            const settled = yield* threads.settle(inbound);

            expect(settled).toBe(expected);

            if (expected && Option.isSome(step.replyTo)) {
              const reply = replies.get(step.replyTo.value);

              expect(reply).toBeDefined();

              if (reply !== undefined) {
                expect(yield* Deferred.await(reply)).toEqual({
                  body: inbound.body,
                  did: step.did,
                  from: "peer",
                  id: inbound.id,
                });
              }

              model.waiting.delete(step.replyTo.value);
            }

            for (const [id, reply] of replies) {
              if (model.waiting.has(id)) {
                expect(Option.isNone(yield* Deferred.poll(reply))).toBe(true);
              }
            }
          });

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- asyncModelRun requires a Promise per command; reuse the live test context.
          return Effect.runPromiseWith(context)(operation);
        },
        toString: () => JSON.stringify(step),
      });

      yield* Effect.tryPromise({
        catch: (cause) => new ModelFailure({ message: String(cause) }),
        try: () =>
          asyncModelRun(
            () => ({ model: { waiting: new Map() }, real: undefined }),
            steps.map(command)
          ),
      });
    }).pipe(Effect.provide(threadsLayer))
);
