import {
  ChannelId,
  ClaimDigest,
  CreateTask,
  Did,
  MessageId,
  taskIdFor,
} from "../src/board.ts";
import type { TaskId } from "../src/board.ts";

export const channel = ChannelId.make("work");

export const owner = Did.make("did:web:owner.example.invalid");

export const guest = Did.make("did:web:guest.example.invalid");

export const taskThread = MessageId.make("task");

export const taskId = taskIdFor(channel, taskThread);

export const ownerDigest = ClaimDigest.make("a".repeat(64));

export const guestDigest = ClaimDigest.make("b".repeat(64));

export const taskFields = (
  dependencies: readonly TaskId[] = [],
  thread = taskThread
) => ({
  channel,
  dependencies,
  owner,
  thread,
  title: "Proof task",
});

export const create = (dependencies: readonly TaskId[] = []) =>
  new CreateTask(taskFields(dependencies));
