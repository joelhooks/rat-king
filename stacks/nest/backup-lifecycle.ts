import { createMachine } from "xstate";

export const backupLifecycle = createMachine({
  context: {},
  id: "mailbox-backup",
  initial: "preflight",
  states: {
    complete: { type: "final" },
    copying: {
      on: {
        copied: { target: "startingMailbox" },
        failed: { target: "recovering" },
      },
    },
    failed: { type: "final" },
    preflight: { on: { ready: { target: "stoppingMailbox" } } },
    publishing: {
      on: {
        abandoned: { target: "failed" },
        published: { target: "verifying" },
      },
    },
    recovering: {
      on: { recovered: { target: "failed" }, refused: { target: "failed" } },
    },
    startingMailbox: {
      on: {
        failed: { target: "recovering" },
        started: { target: "publishing" },
      },
    },
    stoppingMailbox: {
      on: {
        failed: { target: "recovering" },
        stopped: { target: "copying" },
      },
    },
    verifying: {
      on: {
        abandoned: { target: "failed" },
        verified: { target: "complete" },
      },
    },
  },
});
