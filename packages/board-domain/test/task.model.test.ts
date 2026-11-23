import { InMemory } from "@alchemy.run/domain";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Predicate, Result, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { assert, expect } from "vitest";

import {
  BlockTask,
  Board,
  boardPolicies,
  CancelTask,
  ClaimTask,
  FailTask,
  ReleaseClaim,
  Task,
  TaskClosed,
  UnblockTask,
} from "../src/board.ts";
import {
  create,
  guest,
  guestDigest,
  owner,
  ownerDigest,
  taskId,
} from "./fixtures.ts";

const memory = Board.layer(boardPolicies).pipe(Layer.provide(InMemory));

const TaskActions = Schema.Array(
  Schema.Literals(["claim", "release", "block", "unblock", "cancel", "fail"])
).check(Schema.isMaxLength(24));

type Action = (typeof TaskActions.Type)[number];

interface Model {
  epoch: number;
  phase: "ready" | "claimed" | "blocked" | "cancelled" | "failed";
}

it.effect.prop(
  "two concurrent claimants produce one event and one LeaseHeld",
  [Schema.Boolean],
  ([guestFirst]) =>
    Effect.gen(function* race() {
      const tasks = yield* Task;
      yield* tasks.send(taskId, create());

      const attempts = [
        { actor: owner, digest: ownerDigest },
        { actor: guest, digest: guestDigest },
      ].map(({ actor, digest }) =>
        tasks
          .send(taskId, new ClaimTask({ actor, digest, leaseMillis: 30_000 }))
          .pipe(Effect.result)
      );

      const results = yield* Effect.all(
        guestFirst ? attempts.toReversed() : attempts,
        { concurrency: "unbounded" }
      );

      const state = yield* tasks.get(taskId);
      expect(state.task?.phase._tag).toBe("claimed");

      assert(
        Predicate.isTagged(state.task?.phase, "claimed"),
        "Claim not committed"
      );

      const { claim } = state.task.phase;
      const won = results.filter(Result.isSuccess);
      const lost = results.filter(Result.isFailure);
      expect(won).toHaveLength(1);
      expect(won[0]?.success.events.map((event) => event._tag)).toStrictEqual([
        "TaskClaimed",
      ]);
      expect(won[0]?.success.reply.claim).toStrictEqual(claim);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.failure._tag).toBe("LeaseHeld");
    }).pipe(Effect.provide(memory))
);

const sourcePhase = {
  block: "claimed",
  cancel: "ready",
  claim: "ready",
  fail: "claimed",
  release: "claimed",
  unblock: "blocked",
} satisfies Record<Action, Model["phase"]>;

const nextPhase = {
  block: "blocked",
  cancel: "cancelled",
  claim: "claimed",
  fail: "failed",
  release: "ready",
  unblock: "ready",
} satisfies Record<Action, Model["phase"]>;

it.effect.prop(
  "claim, release, block, unblock and terminal moves follow the lifecycle model",
  [Arbitrary.schema(TaskActions)],
  ([actions]) =>
    Effect.gen(function* checkLifecycle() {
      const tasks = yield* Task;
      yield* tasks.send(taskId, create());
      const context = yield* Effect.context();

      const command = (action: Action): AsyncCommand<Model, typeof tasks> => ({
        check: ({ phase }) =>
          phase === sourcePhase[action] ||
          (action === "cancel" && phase === "blocked"),
        // oxlint-disable-next-line typescript/promise-function-async -- fast-check requires a Promise; Effect owns the operation.
        run: (model, real) => {
          const credentials = {
            actor: owner,
            digest: ownerDigest,
            epoch: model.epoch,
          };

          const send = {
            block: real.send(
              taskId,
              new BlockTask({ ...credentials, reason: "blocked" })
            ),
            cancel: real.send(taskId, new CancelTask({ actor: owner })),
            claim: real.send(
              taskId,
              new ClaimTask({
                actor: owner,
                digest: ownerDigest,
                leaseMillis: 30_000,
              })
            ),
            fail: real.send(
              taskId,
              new FailTask({ ...credentials, reason: "failed" })
            ),
            release: real.send(taskId, new ReleaseClaim(credentials)),
            unblock: real.send(taskId, new UnblockTask({ actor: owner })),
          };

          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise at this test boundary.
          return Effect.runPromiseWith(context)(
            Effect.gen(function* run() {
              yield* send[action];

              if (model.phase === "claimed") {
                model.epoch += 1;
              }

              model.phase = nextPhase[action];
              const { task } = yield* real.get(taskId);
              expect(task).toMatchObject({
                epoch: model.epoch,
                phase: { _tag: model.phase },
              });

              if (model.phase === "failed" || model.phase === "cancelled") {
                const closed = yield* real
                  .send(
                    taskId,
                    new ClaimTask({
                      actor: guest,
                      digest: guestDigest,
                      leaseMillis: 30_000,
                    })
                  )
                  .pipe(Effect.flip);

                expect(closed).toBeInstanceOf(TaskClosed);
              }
            })
          );
        },
        toString: () => action,
      });

      // oxlint-disable-next-line typescript/promise-function-async -- Effect.promise owns the fast-check Promise.
      yield* Effect.promise(() =>
        asyncModelRun(
          () => ({
            model: { epoch: 0, phase: "ready" } satisfies Model,
            real: tasks,
          }),
          actions.map(command)
        )
      );
    }).pipe(Effect.provide(memory))
);
