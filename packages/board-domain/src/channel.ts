/* oxlint-disable eslint/max-classes-per-file, eslint/no-redeclare -- Domain schemas, commands and events form one Channel contract. */
import { Aggregate, Command, Event } from "@alchemy.run/domain";
import { DateTime, Match, Predicate, Schema } from "effect";

import {
  ChannelExists,
  ChannelId,
  Did,
  MessageExists,
  MessageId,
  Name,
  NotGranted,
  ReservedLabel,
  Text,
  UnknownChannel,
  UnknownMessage,
} from "./records.ts";

const GrantBits = { read: Schema.Boolean, write: Schema.Boolean };

const MemberGrant = Schema.Struct({ member: Did, ...GrantBits });

const MessageTarget = { message: MessageId, thread: MessageId };

const Mark = Schema.Struct({ actor: Did, value: Name });

const MarkChange = { ...MessageTarget, ...Mark.fields, active: Schema.Boolean };

export const Message = Schema.Struct({
  ...MessageTarget,
  author: Did,
  body: Schema.NullOr(Text),
  createdAt: Schema.Int,
  labels: Schema.Array(Mark),
  reactions: Schema.Array(Mark),
});

export type Message = typeof Message.Type;

export class ChannelOpened extends Event("ChannelOpened", { owner: Did }) {}

export class Granted extends Event("Granted", MemberGrant.fields) {}

export class MessagePosted extends Event("MessagePosted", {
  ...MessageTarget,
  author: Did,
  body: Text,
  createdAt: Schema.Int,
}) {}

export class MessageEdited extends Event("MessageEdited", {
  ...MessageTarget,
  body: Text,
}) {}

export class MessageDeleted extends Event("MessageDeleted", MessageTarget) {}

export class Reacted extends Event("Reacted", MarkChange) {}

export class Labeled extends Event("Labeled", MarkChange) {}

export class OpenChannel extends Command("OpenChannel", {
  events: [ChannelOpened],
  input: { owner: Did },
  rejects: [ChannelExists],
  target: ChannelId,
}) {}

export class Grant extends Command("Grant", {
  events: [Granted],
  input: { actor: Did, ...MemberGrant.fields },
  rejects: [UnknownChannel, NotGranted],
  target: ChannelId,
}) {}

export class PostMessage extends Command("PostMessage", {
  events: [MessagePosted],
  input: {
    actor: Did,
    body: Text,
    message: MessageId,
    thread: Schema.optionalKey(MessageId),
  },
  rejects: [UnknownChannel, NotGranted, MessageExists, UnknownMessage],
  target: ChannelId,
}) {}

const MessageMutation = { actor: Did, message: MessageId };

const MarkMutation = {
  ...MessageMutation,
  active: Schema.Boolean,
  value: Name,
};

const MutationRejections = [
  UnknownChannel,
  NotGranted,
  UnknownMessage,
] as const;

export class EditMessage extends Command("EditMessage", {
  events: [MessageEdited],
  input: { ...MessageMutation, body: Text },
  rejects: MutationRejections,
  target: ChannelId,
}) {}

export class DeleteMessage extends Command("DeleteMessage", {
  events: [MessageDeleted],
  input: MessageMutation,
  rejects: MutationRejections,
  target: ChannelId,
}) {}

export class React extends Command("React", {
  events: [Reacted],
  input: MarkMutation,
  rejects: MutationRejections,
  target: ChannelId,
}) {}

export class Label extends Command("Label", {
  events: [Labeled],
  input: MarkMutation,
  rejects: [...MutationRejections, ReservedLabel],
  target: ChannelId,
}) {}

const ChannelState = Schema.Struct({
  grants: Schema.Array(MemberGrant),
  messages: Schema.Array(Message),
  owner: Schema.NullOr(Did),
});

type ChannelState = typeof ChannelState.Type;

const writing = (state: ChannelState, actor: Did) => {
  if (state.owner === null) {
    return new UnknownChannel({});
  }

  if (
    state.owner === actor ||
    state.grants.some((grant) => grant.member === actor && grant.write)
  ) {
    return null;
  }

  return new NotGranted({ actor });
};

const liveMessage = (state: ChannelState, message: MessageId) =>
  state.messages.find(
    (entry) => entry.message === message && entry.body !== null
  );

const mutate = <E>(input: {
  readonly state: ChannelState;
  readonly actor: Did;
  readonly message: MessageId;
  readonly authorOnly?: boolean;
  readonly record: (entry: Message) => E;
}) => {
  const refused = writing(input.state, input.actor);

  if (refused !== null) {
    return refused;
  }

  const entry = liveMessage(input.state, input.message);

  if (entry === undefined) {
    return new UnknownMessage({ message: input.message });
  }

  if (
    input.authorOnly === true &&
    entry.author !== input.actor &&
    input.state.owner !== input.actor
  ) {
    return new NotGranted({ actor: input.actor });
  }

  return [input.record(entry)];
};

type MessageEvent =
  | MessagePosted
  | MessageEdited
  | MessageDeleted
  | Reacted
  | Labeled;

const mark = (
  marks: readonly (typeof Mark.Type)[],
  { active, actor, value }: Reacted | Labeled
) => {
  const rest = marks.filter(
    (entry) => entry.actor !== actor || entry.value !== value
  );

  return active ? [...rest, { actor, value }] : rest;
};

export const foldMessages = (
  messages: readonly Message[],
  event: MessageEvent
): readonly Message[] => {
  if (Predicate.isTagged(event, "MessagePosted")) {
    const { author, body, createdAt, message, thread } = event;

    return [
      ...messages,
      { author, body, createdAt, labels: [], message, reactions: [], thread },
    ];
  }

  return messages.map((message) => {
    if (message.message !== event.message) {
      return message;
    }

    return Match.value(event).pipe(
      Match.tagsExhaustive({
        Labeled: (change) => ({
          ...message,
          labels: mark(message.labels, change),
        }),
        MessageDeleted: () => ({
          ...message,
          body: null,
          labels: [],
          reactions: [],
        }),
        MessageEdited: ({ body }) => ({ ...message, body }),
        Reacted: (change) => ({
          ...message,
          reactions: mark(message.reactions, change),
        }),
      })
    );
  });
};

const evolveMessage = (state: ChannelState, event: MessageEvent) => ({
  ...state,
  messages: foldMessages(state.messages, event),
});

export class Channel extends Aggregate("Channel", {
  commands: [
    OpenChannel,
    Grant,
    PostMessage,
    EditMessage,
    DeleteMessage,
    React,
    Label,
  ],
  decide: {
    DeleteMessage: (state, { actor, message }) =>
      mutate({
        actor,
        authorOnly: true,
        message,
        record: ({ thread }) => new MessageDeleted({ message, thread }),
        state,
      }),
    EditMessage: (state, { actor, body, message }) =>
      mutate({
        actor,
        authorOnly: true,
        message,
        record: ({ thread }) => new MessageEdited({ body, message, thread }),
        state,
      }),
    Grant: (state, { actor, member, read, write }) => {
      if (state.owner === null) {
        return new UnknownChannel({});
      }

      if (actor !== state.owner) {
        return new NotGranted({ actor });
      }

      return [new Granted({ member, read, write })];
    },
    Label: (state, { active, actor, message, value }) =>
      value.startsWith("board.")
        ? new ReservedLabel({})
        : mutate({
            actor,
            message,
            record: ({ thread }) =>
              new Labeled({ active, actor, message, thread, value }),
            state,
          }),
    OpenChannel: (state, { owner }) =>
      state.owner === null
        ? [new ChannelOpened({ owner })]
        : new ChannelExists({}),
    PostMessage: (state, { actor, body, message, thread }, { now }) => {
      const refused = writing(state, actor);

      if (refused !== null) {
        return refused;
      }

      if (state.messages.some((entry) => entry.message === message)) {
        return new MessageExists({ message });
      }

      if (
        thread !== undefined &&
        liveMessage(state, thread)?.thread !== thread
      ) {
        return new UnknownMessage({ message: thread });
      }

      return [
        new MessagePosted({
          author: actor,
          body,
          createdAt: DateTime.toEpochMillis(now),
          message,
          thread: thread ?? message,
        }),
      ];
    },
    React: (state, { active, actor, message, value }) =>
      mutate({
        actor,
        message,
        record: ({ thread }) =>
          new Reacted({ active, actor, message, thread, value }),
        state,
      }),
  },
  evolve: {
    ChannelOpened: (state, { owner }) => ({ ...state, owner }),
    Granted: (state, { member, read, write }) => ({
      ...state,
      grants: [
        ...state.grants.filter((grant) => grant.member !== member),
        { member, read, write },
      ],
    }),
    Labeled: evolveMessage,
    MessageDeleted: evolveMessage,
    MessageEdited: evolveMessage,
    MessagePosted: evolveMessage,
    Reacted: evolveMessage,
  },
  id: ChannelId,
  initial: { grants: [], messages: [], owner: null },
  state: ChannelState,
}) {}
