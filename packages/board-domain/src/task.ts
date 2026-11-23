/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Domain schemas, commands and events form one Task contract. */
import { Aggregate, Command, Event } from "@alchemy.run/domain";
import { DateTime, Match, Predicate, Schema } from "effect";
import { timingSafeEqual } from "effect/crypto/Mac";

import {
  ChannelId,
  Claim,
  ClaimDigest,
  ClaimLost,
  DependencyUnmet,
  Did,
  Epoch,
  InvalidTaskThread,
  LeaseHeld,
  MessageId,
  NotGranted,
  SelfDependency,
  TaskBlocked,
  TaskClosed,
  TaskExists,
  TaskId,
  taskIdFor,
  Text,
  UnknownTask,
} from "./records.ts";

const Scope = { channel: ChannelId };

const TaskFields = {
  ...Scope,
  dependencies: Schema.Array(TaskId),
  owner: Did,
  thread: MessageId,
  title: Text,
};

const End = { ...Scope, epoch: Epoch };

const Reason = { reason: Text };

const Result = { result: Text };

const ClaimFields = { ...Scope, claim: Claim };

export class TaskCreated extends Event("TaskCreated", TaskFields) {}

export class TaskClaimed extends Event("TaskClaimed", {
  ...ClaimFields,
  digest: ClaimDigest,
}) {}

export class ClaimRenewed extends Event("ClaimRenewed", ClaimFields) {}

export class ClaimReleased extends Event("ClaimReleased", End) {}

export class ClaimExpired extends Event("ClaimExpired", End) {}

export class TaskBlockedEvent extends Event("TaskBlockedEvent", {
  ...End,
  ...Reason,
}) {}

export class TaskUnblocked extends Event("TaskUnblocked", Scope) {}

export class TaskCompleted extends Event("TaskCompleted", {
  ...End,
  ...Result,
  dependents: Schema.Array(TaskId),
}) {}

export class TaskFailed extends Event("TaskFailed", { ...End, ...Reason }) {}

export class TaskCancelled extends Event("TaskCancelled", Scope) {}

export class DependentRegistered extends Event("DependentRegistered", {
  alreadyCompleted: Schema.Boolean,
  dependent: TaskId,
}) {}

export class DependencyCleared extends Event("DependencyCleared", {
  ...Scope,
  dependency: TaskId,
  ready: Schema.Boolean,
}) {}

export const LeaseMillis = Schema.Int.check(
  Schema.isBetween({ maximum: 3_600_000, minimum: 30_000 })
);

const Actor = { actor: Did };

const Fence = { ...Actor, digest: ClaimDigest, epoch: Epoch };

const HolderErrors = [UnknownTask, ClaimLost] as const;

const OwnerErrors = [UnknownTask, TaskClosed, NotGranted, LeaseHeld] as const;

export class CreateTask extends Command("CreateTask", {
  events: [TaskCreated],
  input: TaskFields,
  rejects: [TaskExists, SelfDependency, InvalidTaskThread],
  target: TaskId,
}) {}

export class ClaimTask extends Command("ClaimTask", {
  events: [ClaimExpired, TaskClaimed],
  input: { ...Actor, digest: ClaimDigest, leaseMillis: LeaseMillis },
  rejects: [DependencyUnmet, LeaseHeld, TaskBlocked, TaskClosed, UnknownTask],
  reply: { claim: Schema.NullOr(Claim) },
  target: TaskId,
}) {}

export class RenewClaim extends Command("RenewClaim", {
  events: [ClaimRenewed],
  input: { ...Fence, leaseMillis: LeaseMillis },
  rejects: HolderErrors,
  target: TaskId,
}) {}

export class ReleaseClaim extends Command("ReleaseClaim", {
  events: [ClaimReleased],
  input: Fence,
  rejects: HolderErrors,
  target: TaskId,
}) {}

export class CompleteTask extends Command("CompleteTask", {
  events: [TaskCompleted],
  input: { ...Fence, ...Result },
  rejects: HolderErrors,
  target: TaskId,
}) {}

export class FailTask extends Command("FailTask", {
  events: [TaskFailed],
  input: { ...Fence, ...Reason },
  rejects: HolderErrors,
  target: TaskId,
}) {}

export class BlockTask extends Command("BlockTask", {
  events: [TaskBlockedEvent],
  input: { ...Fence, ...Reason },
  rejects: HolderErrors,
  target: TaskId,
}) {}

export class UnblockTask extends Command("UnblockTask", {
  events: [TaskUnblocked],
  input: Actor,
  rejects: OwnerErrors,
  target: TaskId,
}) {}

export class CancelTask extends Command("CancelTask", {
  events: [TaskCancelled],
  input: Actor,
  rejects: OwnerErrors,
  target: TaskId,
}) {}

export class ExpireClaim extends Command("ExpireClaim", {
  events: [ClaimExpired],
  input: { epoch: Epoch, until: Schema.Int },
  target: TaskId,
}) {}

export class RegisterDependent extends Command("RegisterDependent", {
  events: [DependentRegistered],
  input: { dependent: TaskId },
  target: TaskId,
}) {}

export class DependencySatisfied extends Command("DependencySatisfied", {
  events: [DependencyCleared],
  input: { dependency: TaskId },
  target: TaskId,
}) {}

const Phase = Schema.TaggedUnion({
  blocked: Reason,
  cancelled: {},
  claimed: { claim: Claim },
  completed: Result,
  failed: Reason,
  ready: {},
  waiting: { remaining: Schema.NonEmptyArray(TaskId) },
});

const TaskRecord = Schema.Struct({ ...TaskFields, epoch: Epoch, phase: Phase });

export type TaskRecord = typeof TaskRecord.Type;

export const TaskSnapshot = Schema.NullOr(TaskRecord);

const TaskState = Schema.Struct({
  claimDigest: Schema.NullOr(ClaimDigest),
  dependents: Schema.Array(TaskId),
  task: TaskSnapshot,
});

const closedTask = () => new TaskClosed({});

const closed = (task: TaskRecord) =>
  Predicate.isTagged(task.phase, "completed") ||
  Predicate.isTagged(task.phase, "failed") ||
  Predicate.isTagged(task.phase, "cancelled");

const matchesDigest = (
  expected: ClaimDigest | null,
  submitted: ClaimDigest
) => {
  const ascii = new TextEncoder();

  return (
    expected !== null &&
    timingSafeEqual(ascii.encode(expected), ascii.encode(submitted))
  );
};

const withClaim = <E>(input: {
  readonly state: typeof TaskState.Type;
  readonly fence: {
    readonly actor: Did;
    readonly digest: ClaimDigest;
    readonly epoch: number;
  };
  readonly now: DateTime.Utc;
  readonly record: (task: TaskRecord, claim: Claim) => readonly E[];
}) => {
  const {
    state: { task, claimDigest },
    fence,
    now,
  } = input;

  if (task === null) {
    return new UnknownTask({});
  }

  if (
    task.epoch !== fence.epoch ||
    !Predicate.isTagged(task.phase, "claimed")
  ) {
    return new ClaimLost({ reason: "StaleEpoch" });
  }

  const { claim } = task.phase;

  if (claim.until <= DateTime.toEpochMillis(now)) {
    return new ClaimLost({ reason: "Expired" });
  }

  if (
    claim.holder !== fence.actor ||
    !matchesDigest(claimDigest, fence.digest)
  ) {
    return new ClaimLost({ reason: "CredentialMismatch" });
  }

  return input.record(task, claim);
};

const asOwner = <E>(
  task: TaskRecord | null,
  actor: Did,
  record: (task: TaskRecord) => readonly E[]
) => {
  if (task === null) {
    return new UnknownTask({});
  }

  if (task.owner !== actor) {
    return new NotGranted({ actor });
  }

  if (closed(task)) {
    return new TaskClosed({});
  }

  if (Predicate.isTagged(task.phase, "claimed")) {
    return new LeaseHeld({ claim: task.phase.claim });
  }

  return record(task);
};

type TaskEvent =
  | TaskCreated
  | TaskClaimed
  | ClaimRenewed
  | ClaimReleased
  | ClaimExpired
  | TaskBlockedEvent
  | TaskUnblocked
  | TaskCompleted
  | TaskFailed
  | TaskCancelled
  | DependencyCleared;

const waiting = (remaining: readonly TaskId[]): TaskRecord["phase"] => {
  const [first, ...rest] = remaining;

  return first === undefined
    ? Phase.cases.ready.make({})
    : Phase.cases.waiting.make({ remaining: [first, ...rest] });
};

export const foldTask = (
  task: TaskRecord | null,
  event: TaskEvent
): TaskRecord | null => {
  if (Predicate.isTagged(event, "TaskCreated")) {
    const { channel, owner, thread, title, dependencies } = event;

    return {
      channel,
      dependencies,
      epoch: 0,
      owner,
      phase: waiting(dependencies),
      thread,
      title,
    };
  }

  if (task === null) {
    return task;
  }

  const move = (
    phase: TaskRecord["phase"],
    epoch = task.epoch
  ): TaskRecord => ({ ...task, epoch, phase });

  const claimed = ({ claim }: TaskClaimed | ClaimRenewed) =>
    move(Phase.cases.claimed.make({ claim }));

  const ready = ({ epoch }: ClaimExpired | ClaimReleased) =>
    move(Phase.cases.ready.make({}), epoch);

  return Match.value(event).pipe(
    Match.tagsExhaustive({
      ClaimExpired: ready,
      ClaimReleased: ready,
      ClaimRenewed: claimed,
      DependencyCleared: ({ dependency }) =>
        Predicate.isTagged(task.phase, "waiting")
          ? move(
              waiting(task.phase.remaining.filter((id) => id !== dependency))
            )
          : task,
      TaskBlockedEvent: ({ epoch, reason }) =>
        move(Phase.cases.blocked.make({ reason }), epoch),
      TaskCancelled: () => move(Phase.cases.cancelled.make({})),
      TaskClaimed: claimed,
      TaskCompleted: ({ epoch, result }) =>
        move(Phase.cases.completed.make({ result }), epoch),
      TaskFailed: ({ epoch, reason }) =>
        move(Phase.cases.failed.make({ reason }), epoch),
      TaskUnblocked: () => move(Phase.cases.ready.make({})),
    })
  );
};

const evolveTask = (state: typeof TaskState.Type, event: TaskEvent) => {
  const task = foldTask(state.task, event);

  const existing = Predicate.isTagged(task?.phase, "claimed")
    ? state.claimDigest
    : null;

  return {
    ...state,
    claimDigest: Predicate.isTagged(event, "TaskClaimed")
      ? event.digest
      : existing,
    task,
  };
};

export class Task extends Aggregate("Task", {
  commands: [
    CreateTask,
    ClaimTask,
    RenewClaim,
    ReleaseClaim,
    CompleteTask,
    FailTask,
    BlockTask,
    UnblockTask,
    CancelTask,
    ExpireClaim,
    RegisterDependent,
    DependencySatisfied,
  ],
  decide: {
    BlockTask: (state, fence, { now }) =>
      withClaim({
        fence,
        now,
        record: ({ channel, epoch }) => [
          new TaskBlockedEvent({
            channel,
            epoch: epoch + 1,
            reason: fence.reason,
          }),
        ],
        state,
      }),
    CancelTask: ({ task }, { actor }) =>
      asOwner(task, actor, ({ channel }) => [new TaskCancelled({ channel })]),
    ClaimTask: (
      { task, claimDigest },
      { actor, digest, leaseMillis },
      { now }
    ) => {
      if (task === null) {
        return new UnknownTask({});
      }

      const at = DateTime.toEpochMillis(now);

      const claimAt = (epoch: number) =>
        new TaskClaimed({
          channel: task.channel,
          claim: { epoch, holder: actor, until: at + leaseMillis },
          digest,
        });

      return Match.value(task.phase).pipe(
        Match.tagsExhaustive({
          blocked: ({ reason }) => new TaskBlocked({ reason }),
          cancelled: closedTask,
          claimed: ({ claim }) => {
            if (claim.until <= at) {
              const epoch = task.epoch + 1;

              return [
                new ClaimExpired({ channel: task.channel, epoch }),
                claimAt(epoch),
              ];
            }

            return claim.holder === actor && matchesDigest(claimDigest, digest)
              ? []
              : new LeaseHeld({ claim });
          },
          completed: closedTask,
          failed: closedTask,
          ready: () => [claimAt(task.epoch)],
          waiting: ({ remaining }) => new DependencyUnmet({ remaining }),
        })
      );
    },
    CompleteTask: (state, fence, { now }) =>
      withClaim({
        fence,
        now,
        record: ({ channel, epoch }) => [
          new TaskCompleted({
            channel,
            dependents: state.dependents,
            epoch: epoch + 1,
            result: fence.result,
          }),
        ],
        state,
      }),
    CreateTask: (
      { task },
      { channel, dependencies, owner, thread, title },
      { id }
    ) => {
      if (task !== null) {
        return new TaskExists({});
      }

      if (id !== taskIdFor(channel, thread)) {
        return new InvalidTaskThread({});
      }

      if (dependencies.includes(id)) {
        return new SelfDependency({});
      }

      return [
        new TaskCreated({
          channel,
          dependencies: [...new Set(dependencies)],
          owner,
          thread,
          title,
        }),
      ];
    },
    DependencySatisfied: ({ task }, { dependency }) =>
      task !== null &&
      Predicate.isTagged(task.phase, "waiting") &&
      task.phase.remaining.includes(dependency)
        ? [
            new DependencyCleared({
              channel: task.channel,
              dependency,
              ready: task.phase.remaining.length === 1,
            }),
          ]
        : [],
    ExpireClaim: ({ task }, { epoch, until }, { now }) =>
      task !== null &&
      Predicate.isTagged(task.phase, "claimed") &&
      task.epoch === epoch &&
      task.phase.claim.until === until &&
      until <= DateTime.toEpochMillis(now)
        ? [new ClaimExpired({ channel: task.channel, epoch: epoch + 1 })]
        : [],
    FailTask: (state, fence, { now }) =>
      withClaim({
        fence,
        now,
        record: ({ channel, epoch }) => [
          new TaskFailed({ channel, epoch: epoch + 1, reason: fence.reason }),
        ],
        state,
      }),
    RegisterDependent: ({ dependents, task }, { dependent }, { id }) =>
      dependent === id || dependents.includes(dependent)
        ? []
        : [
            new DependentRegistered({
              alreadyCompleted: Predicate.isTagged(task?.phase, "completed"),
              dependent,
            }),
          ],
    ReleaseClaim: (state, fence, { now }) =>
      withClaim({
        fence,
        now,
        record: ({ channel, epoch }) => [
          new ClaimReleased({ channel, epoch: epoch + 1 }),
        ],
        state,
      }),
    RenewClaim: (state, fence, { now }) =>
      withClaim({
        fence,
        now,
        record: ({ channel }, claim) => {
          const until = DateTime.toEpochMillis(now) + fence.leaseMillis;

          return until > claim.until
            ? [new ClaimRenewed({ channel, claim: { ...claim, until } })]
            : [];
        },
        state,
      }),
    UnblockTask: ({ task }, { actor }) =>
      asOwner(task, actor, ({ channel, phase }) =>
        Predicate.isTagged(phase, "blocked")
          ? [new TaskUnblocked({ channel })]
          : []
      ),
  },
  evolve: {
    ClaimExpired: evolveTask,
    ClaimReleased: evolveTask,
    ClaimRenewed: evolveTask,
    DependencyCleared: evolveTask,
    DependentRegistered: (state, { dependent }) => ({
      ...state,
      dependents: [...state.dependents, dependent],
    }),
    TaskBlockedEvent: evolveTask,
    TaskCancelled: evolveTask,
    TaskClaimed: evolveTask,
    TaskCompleted: evolveTask,
    TaskCreated: evolveTask,
    TaskFailed: evolveTask,
    TaskUnblocked: evolveTask,
  },
  id: TaskId,
  initial: { claimDigest: null, dependents: [], task: null },
  reply: {
    ClaimTask: ({ task }) => ({
      claim:
        task !== null && Predicate.isTagged(task.phase, "claimed")
          ? task.phase.claim
          : null,
    }),
  },
  state: TaskState,
}) {}
