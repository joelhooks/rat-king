/* oxlint-disable eslint/max-classes-per-file, oxc/no-barrel-file -- Board is the named workspace contract for its aggregates and policies. */
import { Model, Policy } from "@alchemy.run/domain";
import { Context, Data, DateTime, Effect, Layer, Match } from "effect";

import { Channel, Labeled, MessagePosted } from "./channel.ts";
import type { ChannelId } from "./records.ts";
import {
  ClaimRenewed,
  DependencySatisfied,
  DependentRegistered,
  ExpireClaim,
  RegisterDependent,
  Task,
  TaskClaimed,
  TaskCompleted,
  TaskCreated,
} from "./task.ts";
import { ChannelThreads, ReadyTasks, TaskView, ThreadView } from "./views.ts";

class ArmClaimExpiry extends Policy("ArmClaimExpiry", {
  from: Task,
  on: [TaskClaimed, ClaimRenewed],
}) {}

const armClaimExpiry = ArmClaimExpiry.toLayer(
  Effect.gen(function* buildClaimExpiry() {
    const tasks = yield* Task;

    return Effect.fn("Board.armClaimExpiry")(function* scheduleExpiry({
      event: { claim },
      source,
    }) {
      yield* tasks.schedule(
        source,
        new ExpireClaim({ epoch: claim.epoch, until: claim.until }),
        {
          at: DateTime.makeUnsafe(claim.until),
          commandId: "claim-expiry",
        }
      );
    });
  })
);

export class ReleaseDependents extends Policy("ReleaseDependents", {
  from: Task,
  on: [TaskCreated, TaskCompleted, DependentRegistered],
}) {}

const releaseDependents = ReleaseDependents.toLayer(
  Effect.gen(function* buildReleaseDependents() {
    const tasks = yield* Task;

    return Effect.fn("Board.releaseDependents")(({ event, source }) =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          DependentRegistered: ({ alreadyCompleted, dependent }) =>
            alreadyCompleted
              ? tasks
                  .send(
                    dependent,
                    new DependencySatisfied({ dependency: source.id })
                  )
                  .pipe(Effect.asVoid)
              : Effect.void,
          TaskCompleted: ({ dependents }) =>
            Effect.forEach(
              dependents,
              (id) =>
                tasks.send(
                  id,
                  new DependencySatisfied({ dependency: source.id })
                ),
              { discard: true }
            ),
          TaskCreated: ({ dependencies }) =>
            Effect.forEach(
              dependencies,
              (id) =>
                tasks.send(id, new RegisterDependent({ dependent: source.id })),
              { discard: true }
            ),
        })
      )
    );
  })
);

export class WakeWatchers extends Policy("WakeWatchers", {
  from: Channel,
  on: [MessagePosted, Labeled],
}) {}

export class WakeDeliveryFailed extends Data.TaggedError("WakeDeliveryFailed")<{
  readonly reason: string;
}> {}

export class WatcherWake extends Context.Service<
  WatcherWake,
  {
    readonly onChannelEvent: (input: {
      readonly channel: ChannelId;
      readonly event: MessagePosted | Labeled;
      readonly idempotencyKey: string;
    }) => Effect.Effect<void, WakeDeliveryFailed>;
  }
>()("rat-king/board/WatcherWake") {}

export const wakeWatchers = WakeWatchers.toLayer(
  Effect.gen(function* wakeWatchers() {
    const wakes = yield* WatcherWake;

    return ({ envelope, event, source }) =>
      wakes
        .onChannelEvent({
          channel: source.id,
          event,
          idempotencyKey: `${envelope.stream}:${envelope.seq}`,
        })
        .pipe(Effect.orDie);
  })
);

export class Board extends Model("Board", {
  aggregates: [Channel, Task],
  policies: [ArmClaimExpiry, ReleaseDependents],
  views: [ChannelThreads, ThreadView, ReadyTasks, TaskView],
}) {}

export const boardPolicies = Layer.merge(armClaimExpiry, releaseDependents);

export * from "./channel.ts";

export * from "./lease.ts";

export * from "./records.ts";

export * from "./task.ts";

export * from "./views.ts";
