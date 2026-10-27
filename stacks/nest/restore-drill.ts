import { Console, Effect, Schema } from "effect";
import { createMachine, transition } from "xstate";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { localExec } from "../../packages/alchemy-nest/src/local-exec.ts";
import { MailboxKeyProof } from "./restore-drill-mailbox-projection.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Text = Schema.NonEmptyString;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Tree = Schema.Struct({ bytes: Count, directories: Count, files: Count });

export const restoreDrillLifecycle = createMachine({
  context: {},
  id: "mailbox-restore-drill",
  initial: "configured",
  states: {
    checkingReceipt: {
      on: { rejected: { target: "failed" }, verified: { target: "complete" } },
    },
    complete: { type: "final" },
    configured: { on: { started: { target: "running" } } },
    failed: { type: "final" },
    running: {
      on: {
        failed: { target: "failed" },
        finished: { target: "checkingReceipt" },
      },
    },
  },
});

export const PassingDrillReceipt = Schema.Struct({
  archiveId: Text.check(
    Schema.isPattern(/^\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{32}$/u)
  ),
  error: Schema.Null,
  proofs: Schema.Struct({
    health: Schema.Struct({ commit: Text, version: Text }),
    inventories: Schema.Struct({ celld: Tree, seaweedfs: Tree }),
    lease: Schema.Struct({
      did: Text,
      expiresAt: Schema.Finite,
      generation: Count,
      leaseId: Text,
    }),
    mailboxCounts: Schema.Struct({
      events: Count,
      mailboxes: Count.check(Schema.isGreaterThan(0)),
      messages: Count.check(Schema.isGreaterThan(0)),
      tolerance: Schema.Literal(0),
    }),
    mailboxKeyProofs: Schema.Array(MailboxKeyProof).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(2)
    ),
    message: Schema.Struct({
      messageId: Text,
      recipientDid: Text,
      senderDid: Text,
      seq: Count.check(Schema.isGreaterThan(0)),
    }),
    sha256: Text.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  runId: Text.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("pass"),
  teardown: Schema.Struct({
    processesAbsent: Schema.Literal(true),
    rootAbsent: Schema.Literal(true),
    unitAbsent: Schema.Literal(true),
  }),
});

export const restoreDrill = Effect.fn("MailboxRestore.drill")(
  function* restoreDrill(config: StageConfigValue) {
    if (
      config.runtime.RAT_KING_STAGE !== "fleet" ||
      config.restoreDrill === undefined
    ) {
      return yield* refuse(
        "Restore drill requires fleet stage and explicit restoreDrill configuration"
      );
    }

    let state = restoreDrillLifecycle.resolveState({
      context: {},
      value: "configured",
    });

    const checkpoint = (type: string) => {
      [state] = transition(restoreDrillLifecycle, state, { type });
    };

    checkpoint("started");
    const shell = yield* localExec;
    const settings = config.restoreDrill;

    const result = yield* shell.exec([
      "python3",
      new URL("restore-drill.py", import.meta.url).pathname,
      JSON.stringify({
        ...settings,
        backupRoot: config.runtime.RAT_KING_BACKUP_ROOT,
        inventory: config.runtime.RATS_NEST_INSTANCE,
      }),
      settings.receipts,
    ]);

    const output = yield* Schema.decodeUnknownEffect(Schema.String)(
      result.stdout
    );

    yield* Console.log(output.trim());

    if (result.code !== 0) {
      checkpoint("failed");

      return yield* refuse("Restore drill failed; inspect its JSONL receipt");
    }

    checkpoint("finished");
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PassingDrillReceipt)
    )(output.trim()).pipe(
      Effect.mapError(() => {
        checkpoint("rejected");

        return refuse(
          "Restore drill returned an incomplete proof or teardown receipt"
        );
      })
    );
    checkpoint("verified");

    if (!state.matches("complete")) {
      return yield* refuse("Restore drill lifecycle did not complete");
    }

    return yield* Effect.void;
  }
);
