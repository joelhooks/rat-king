import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import {
  Board,
  boardPolicies,
  Channel,
  ChannelOpened,
  ChannelThreads,
  ClaimExpired,
  ClaimLost,
  ClaimRenewed,
  ClaimTask,
  CompleteTask,
  DeleteMessage,
  DependentRegistered,
  DependencyCleared,
  DependencyUnmet,
  EditMessage,
  Grant,
  Granted,
  Label,
  Labeled,
  MessageDeleted,
  MessageEdited,
  MessageId,
  MessagePosted,
  NotGranted,
  PostMessage,
  React,
  Reacted,
  ReadyTasks,
  RenewClaim,
  ReservedLabel,
  LeaseMillis,
  Task,
  TaskClaimed,
  TaskCompleted,
  TaskCreated,
  taskIdFor,
  Text,
  TaskView,
  ThreadView,
  threadKey,
} from "../src/board.ts";
import {
  channel,
  create,
  guest,
  guestDigest,
  owner,
  ownerDigest,
  taskFields,
  taskId,
} from "./fixtures.ts";

const story = Story.make(Board, { layer: boardPolicies });

const task = Task.ref(taskId);

const room = Channel.ref(channel);

const root = MessageId.make("root");

const reply = MessageId.make("reply");

const committed = Story.then;

it.effect.prop(
  "renew replaces the old deadline; expiry fences the former holder",
  [Arbitrary.schema(LeaseMillis)],
  ([leaseMillis]) => {
    const claim = { epoch: 0, holder: owner, until: leaseMillis };

    const complete = new CompleteTask({
      actor: owner,
      digest: ownerDigest,
      epoch: 0,
      result: "old result",
    });

    return story(
      Story.clock(0),
      Story.when(task, create()),
      Story.when(
        task,
        new ClaimTask({ actor: owner, digest: ownerDigest, leaseMillis })
      ),
      committed(
        task,
        new TaskCreated(taskFields()),
        new TaskClaimed({ channel, claim, digest: ownerDigest })
      ),
      Story.advance(leaseMillis - 1),
      Story.when(
        task,
        new RenewClaim({
          actor: owner,
          digest: ownerDigest,
          epoch: 0,
          leaseMillis,
        })
      ),
      committed(
        task,
        new ClaimRenewed({
          channel,
          claim: { ...claim, until: 2 * leaseMillis - 1 },
        })
      ),
      Story.advance(1),
      Story.view(TaskView, task, (state) => {
        expect(state?.phase._tag).toBe("claimed");
      }),
      Story.view(ReadyTasks, channel, (ids) => {
        expect(ids).toStrictEqual([]);
      }),
      Story.advance(leaseMillis - 1),
      committed(task, new ClaimExpired({ channel, epoch: 1 })),
      Story.view(ReadyTasks, channel, (ids) => {
        expect(ids).toStrictEqual([taskId]);
      }),
      Story.when(
        task,
        new ClaimTask({ actor: guest, digest: guestDigest, leaseMillis })
      ),
      committed(
        task,
        new TaskClaimed({
          channel,
          claim: { epoch: 1, holder: guest, until: 3 * leaseMillis - 1 },
          digest: guestDigest,
        })
      ),
      Story.when(task, complete),
      Story.rejected(new ClaimLost({ reason: "StaleEpoch" }))
    );
  }
);

it.effect.prop(
  "a claim replaces a lapsed generation atomically when the alarm has not fired",
  [Arbitrary.schema(LeaseMillis)],
  ([leaseMillis]) => {
    const oldClaim = { epoch: 0, holder: owner, until: leaseMillis };
    const replacement = { epoch: 1, holder: guest, until: 2 * leaseMillis };

    return story(
      Story.clock(leaseMillis),
      Story.given(
        task,
        new TaskCreated(taskFields()),
        new TaskClaimed({ channel, claim: oldClaim, digest: ownerDigest })
      ),
      Story.when(
        task,
        new ClaimTask({ actor: guest, digest: guestDigest, leaseMillis })
      ),
      committed(
        task,
        new ClaimExpired({ channel, epoch: 1 }),
        new TaskClaimed({ channel, claim: replacement, digest: guestDigest })
      ),
      Story.replied({ claim: replacement }),
      Story.when(
        task,
        new CompleteTask({
          actor: owner,
          digest: ownerDigest,
          epoch: 0,
          result: "stale",
        })
      ),
      Story.rejected(new ClaimLost({ reason: "StaleEpoch" }))
    );
  }
);

it.effect.prop(
  "completion releases a dependency registered before or after it completes",
  [Schema.Boolean],
  ([registeredFirst]) => {
    const prerequisiteThread = MessageId.make("prerequisite");
    const prerequisiteId = taskIdFor(channel, prerequisiteThread);
    const prerequisite = Task.ref(prerequisiteId);
    const claim = { epoch: 0, holder: owner, until: 30_000 };

    const completion = [
      Story.when(
        prerequisite,
        new CompleteTask({
          actor: owner,
          digest: ownerDigest,
          epoch: 0,
          result: "finished",
        })
      ),
    ] as const;

    const completed = new TaskCompleted({
      channel,
      dependents: registeredFirst ? [taskId] : [],
      epoch: 1,
      result: "finished",
    });

    const registered = new DependentRegistered({
      alreadyCompleted: !registeredFirst,
      dependent: taskId,
    });

    return story(
      Story.clock(0),
      Story.given(
        prerequisite,
        new TaskCreated(taskFields([], prerequisiteThread)),
        new TaskClaimed({ channel, claim, digest: ownerDigest })
      ),
      ...(registeredFirst ? [] : completion),
      Story.when(task, create([prerequisiteId])),
      ...(registeredFirst
        ? [
            Story.when(
              task,
              new ClaimTask({
                actor: guest,
                digest: guestDigest,
                leaseMillis: 30_000,
              })
            ),
            Story.rejected(
              new DependencyUnmet({ remaining: [prerequisiteId] })
            ),
            ...completion,
          ]
        : []),
      committed(
        prerequisite,
        ...(registeredFirst ? [registered, completed] : [completed, registered])
      ),
      committed(
        task,
        new TaskCreated(taskFields([prerequisiteId])),
        new DependencyCleared({
          channel,
          dependency: prerequisiteId,
          ready: true,
        })
      ),
      Story.view(TaskView, task, (state) => {
        expect(state?.phase._tag).toBe("ready");
      })
    );
  }
);

it.effect.prop(
  "only writers post; authorized mutations fold into both thread views",
  [Arbitrary.schema(Text)],
  ([body]) =>
    story(
      Story.clock(0),
      Story.given(room, new ChannelOpened({ owner })),
      Story.when(
        room,
        new Grant({ actor: owner, member: guest, read: true, write: false })
      ),
      Story.when(room, new PostMessage({ actor: guest, body, message: root })),
      Story.rejected(new NotGranted({ actor: guest })),
      Story.when(
        room,
        new Grant({ actor: owner, member: guest, read: true, write: true })
      ),
      Story.when(room, new PostMessage({ actor: guest, body, message: root })),
      committed(
        room,
        new Granted({ member: guest, read: true, write: false }),
        new Granted({ member: guest, read: true, write: true }),
        new MessagePosted({
          author: guest,
          body,
          createdAt: 0,
          message: root,
          thread: root,
        })
      ),
      Story.when(
        room,
        new PostMessage({
          actor: owner,
          body: "first reply",
          message: reply,
          thread: root,
        })
      ),
      Story.when(
        room,
        new EditMessage({ actor: owner, body: "edited reply", message: reply })
      ),
      Story.when(
        room,
        new React({
          active: true,
          actor: guest,
          message: reply,
          value: "agree",
        })
      ),
      Story.when(
        room,
        new Label({
          active: true,
          actor: owner,
          message: reply,
          value: "important",
        })
      ),
      Story.when(
        room,
        new Label({
          active: true,
          actor: owner,
          message: reply,
          value: "board.task",
        })
      ),
      Story.rejected(new ReservedLabel({})),
      Story.when(room, new DeleteMessage({ actor: guest, message: root })),
      committed(
        room,
        new MessagePosted({
          author: owner,
          body: "first reply",
          createdAt: 0,
          message: reply,
          thread: root,
        }),
        new MessageEdited({
          body: "edited reply",
          message: reply,
          thread: root,
        }),
        new Reacted({
          active: true,
          actor: guest,
          message: reply,
          thread: root,
          value: "agree",
        }),
        new Labeled({
          active: true,
          actor: owner,
          message: reply,
          thread: root,
          value: "important",
        }),
        new MessageDeleted({ message: root, thread: root })
      ),
      Story.view(ChannelThreads, room, (threads) => {
        expect(threads).toStrictEqual([{ messages: 1, thread: root }]);
      }),
      Story.view(ThreadView, threadKey(channel, root), (entries) => {
        expect(entries.messages).toMatchObject([
          { body: null, message: root },
          {
            body: "edited reply",
            labels: [{ actor: owner, value: "important" }],
            message: reply,
            reactions: [{ actor: guest, value: "agree" }],
          },
        ]);
      })
    )
);
