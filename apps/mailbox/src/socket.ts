import * as Subscribe from "@rat-king/lexicon/mailbox.subscribe";
import { Schema } from "effect";
import { createMachine, transition } from "xstate";

export const socketMachine = createMachine({
  context: {},
  id: "mailbox-subscription",
  initial: "awaitingAuth",
  states: {
    authenticated: { on: { close: { target: "closed" } } },
    authenticating: {
      on: { accept: { target: "authenticated" }, close: { target: "closed" } },
    },
    awaitingAuth: {
      on: {
        authenticate: { target: "authenticating" },
        close: { target: "closed" },
      },
    },
    closed: { type: "final" },
  },
});

export const SocketAttachment = Schema.Struct({
  ...Subscribe.Params.schema.fields,
  deadline: Schema.Int,
  state: Schema.Literals([
    "awaitingAuth",
    "authenticating",
    "authenticated",
    "closed",
  ]),
});

export type SocketAttachmentValue = typeof SocketAttachment.Type;

export const socketStep = (
  attachment: SocketAttachmentValue,
  type: "authenticate" | "accept" | "close"
) => {
  const [next] = transition(
    socketMachine,
    socketMachine.resolveState({ context: {}, value: attachment.state }),
    { type }
  );

  return Schema.decodeUnknownSync(SocketAttachment)({
    ...attachment,
    state: next.value,
  });
};

export const socketCodes = { auth: 4401, stale: 4409, timeout: 4408 } as const;
