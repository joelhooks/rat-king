/* oxlint-disable eslint/max-classes-per-file -- Domain views and their events share the board projection contract. */
import { Event, View } from "@alchemy.run/domain";
import { Predicate, Schema } from "effect";

import { Channel, foldMessages, Message } from "./channel.ts";
import type { MessageDeleted, MessagePosted } from "./channel.ts";
import {
  ChannelId,
  MessageId,
  TaskId,
  TaskStateLabel,
  ThreadKey,
  threadKey,
} from "./records.ts";
import { foldTask, Task, TaskSnapshot } from "./task.ts";
import type { TaskRecord } from "./task.ts";

const ThreadSummaries = Schema.Array(
  Schema.Struct({ messages: Schema.Int, thread: MessageId })
);

const countMessage = (
  threads: typeof ThreadSummaries.Type,
  event: MessagePosted | MessageDeleted
) => {
  const current = threads.find(({ thread }) => thread === event.thread);

  const count =
    (current?.messages ?? 0) +
    (Predicate.isTagged(event, "MessagePosted") ? 1 : -1);

  if (current === undefined) {
    return [...threads, { messages: count, thread: event.thread }];
  }

  if (count === 0) {
    return threads.filter(({ thread }) => thread !== event.thread);
  }

  return threads.map((entry) =>
    entry.thread === event.thread ? { ...entry, messages: count } : entry
  );
};

export class ChannelThreads extends View("ChannelThreads", {
  evolve: { MessageDeleted: countMessage, MessagePosted: countMessage },
  from: [Channel],
  initial: [],
  key: Channel,
  state: ThreadSummaries,
}) {}

class TaskChanged extends Event("TaskChanged", { transition: Schema.String }) {}

const changed = (event: { readonly _tag: string }) => [
  new TaskChanged({ transition: event._tag }),
];

export class TaskView extends View("TaskView", {
  emit: {
    ClaimExpired: changed,
    ClaimReleased: changed,
    ClaimRenewed: changed,
    DependencyCleared: changed,
    TaskBlockedEvent: changed,
    TaskCancelled: changed,
    TaskClaimed: changed,
    TaskCompleted: changed,
    TaskCreated: changed,
    TaskFailed: changed,
    TaskUnblocked: changed,
  },
  events: [TaskChanged],
  evolve: {
    ClaimExpired: foldTask,
    ClaimReleased: foldTask,
    ClaimRenewed: foldTask,
    DependencyCleared: foldTask,
    TaskBlockedEvent: foldTask,
    TaskCancelled: foldTask,
    TaskClaimed: foldTask,
    TaskCompleted: foldTask,
    TaskCreated: foldTask,
    TaskFailed: foldTask,
    TaskUnblocked: foldTask,
  },
  from: [Task],
  initial: null,
  key: Task,
  state: TaskSnapshot,
}) {}

const StateLabel = Schema.Struct({
  key: Schema.Literal(TaskStateLabel),
  value: Schema.String,
});

const ThreadState = Schema.Struct({
  messages: Schema.Array(Message),
  task: TaskSnapshot,
  taskLabel: Schema.NullOr(StateLabel),
});

const routeThread = ({
  event,
  source,
}: {
  readonly event: { readonly thread: MessageId };
  readonly source: { readonly id: ChannelId };
}) => threadKey(source.id, event.thread);

const evolveThread = (
  state: typeof ThreadState.Type,
  event: Parameters<typeof foldMessages>[1]
) => ({
  ...state,
  messages: foldMessages(state.messages, event),
});

const taskLabel = (task: TaskRecord) =>
  StateLabel.make({ key: TaskStateLabel, value: task.phase._tag });

export class ThreadView extends View("ThreadView", {
  evolve: {
    Labeled: evolveThread,
    MessageDeleted: evolveThread,
    MessageEdited: evolveThread,
    MessagePosted: evolveThread,
    Reacted: evolveThread,
    TaskChanged: (current, _, { state }) => ({
      ...current,
      task: state,
      taskLabel: state === null ? null : taskLabel(state),
    }),
  },
  from: [Channel, TaskView],
  initial: { messages: [], task: null, taskLabel: null },
  key: ThreadKey,
  keyOf: {
    Labeled: routeThread,
    MessageDeleted: routeThread,
    MessageEdited: routeThread,
    MessagePosted: routeThread,
    Reacted: routeThread,
    TaskChanged: ({ state }) =>
      state === null ? undefined : threadKey(state.channel, state.thread),
  },
  state: ThreadState,
}) {}

const ReadyIds = Schema.Array(TaskId);

const channelOf = ({
  event,
}: {
  readonly event: { readonly channel: ChannelId };
}) => event.channel;

interface ReadyTransition {
  readonly channel: ChannelId;
}

const addReady = (
  ids: typeof ReadyIds.Type,
  _: ReadyTransition,
  { source }: { readonly source: { readonly id: TaskId } }
) => (ids.includes(source.id) ? ids : [...ids, source.id]);

const removeReady = (
  ids: typeof ReadyIds.Type,
  _: ReadyTransition,
  { source }: { readonly source: { readonly id: TaskId } }
) => ids.filter((id) => id !== source.id);

export class ReadyTasks extends View("ReadyTasks", {
  events: [],
  evolve: {
    ClaimExpired: addReady,
    ClaimReleased: addReady,
    DependencyCleared: (ids, event, ctx) =>
      event.ready ? addReady(ids, event, ctx) : ids,
    TaskCancelled: removeReady,
    TaskClaimed: removeReady,
    TaskCreated: (ids, event, ctx) =>
      event.dependencies.length === 0 ? addReady(ids, event, ctx) : ids,
    TaskUnblocked: addReady,
  },
  from: [Task],
  initial: [],
  key: ChannelId,
  keyOf: {
    ClaimExpired: channelOf,
    ClaimReleased: channelOf,
    DependencyCleared: channelOf,
    TaskCancelled: channelOf,
    TaskClaimed: channelOf,
    TaskCreated: channelOf,
    TaskUnblocked: channelOf,
  },
  state: ReadyIds,
}) {}
