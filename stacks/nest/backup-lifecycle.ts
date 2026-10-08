import { createMachine } from "xstate";

export const backupLifecycle = createMachine({
  context: {},
  id: "mailbox-backup",
  initial: "preflight",
  on: { failed: { target: ".recovering" } },
  states: {
    complete: { type: "final" },
    exporting: { on: { exported: { target: "snapshotting" } } },
    failed: { type: "final" },
    preflight: { on: { ready: { target: "preparing" } } },
    preparing: { on: { prepared: { target: "stoppingCelld" } } },
    publishing: { on: { published: { target: "complete" } } },
    recovering: {
      on: { recovered: { target: "failed" }, refused: { target: "failed" } },
    },
    restartingCelld: { on: { started: { target: "publishing" } } },
    snapshotting: { on: { copied: { target: "restartingCelld" } } },
    stoppingCelld: { on: { stopped: { target: "exporting" } } },
  },
});
