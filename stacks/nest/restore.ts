import { Effect, Exit, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { must } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { backupScript } from "./backup-script.ts";
import { nodeService, startMailbox, storeService } from "./backup.ts";

export interface RestoreRequest {
  readonly backupRoot: string;
  readonly source: string;
}

const SnapshotName = Schema.String.check(
  Schema.isPattern(/^[0-9TZ.]+-[a-f0-9]{32}$/u)
);

export const preflightRestore = Effect.fn("MailboxRestore.preflight")(
  function* preflightRestore(
    shell: Interface,
    dataRoot: string,
    backupRoot: string
  ) {
    const selected = yield* must(shell, [
      "python3",
      "-c",
      backupScript,
      "restore-preflight",
      dataRoot,
      backupRoot,
    ]);

    const source = yield* Schema.decodeEffect(SnapshotName)(
      selected.trim()
    ).pipe(
      Effect.mapError(() => refuse("Malformed restore snapshot selection"))
    );

    return { backupRoot, source } satisfies RestoreRequest;
  }
);

const Fetched = Schema.Tuple([
  Schema.String.check(
    Schema.isPattern(/^\/\S*\/\.mailbox-restore-[a-f0-9]{32}$/u)
  ),
  SnapshotName,
]);

export const restoreSnapshot = Effect.fn("MailboxRestore.snapshot")(
  function* restoreSnapshot(
    shell: Pick<Interface, "exec">,
    dataRoot: string,
    backupRoot: string,
    selected?: string
  ) {
    const script = (action: string, ...args: readonly string[]) =>
      must(shell, [
        "python3",
        "-c",
        backupScript,
        action,
        dataRoot,
        backupRoot,
        ...args,
      ]);

    const [local, source] = yield* Schema.decodeUnknownEffect(Fetched)(
      (yield* script(
        "snapshot-fetch",
        ...(selected === undefined ? [] : [selected])
      ))
        .trim()
        .split(" ")
    ).pipe(Effect.mapError(() => refuse("Malformed restore snapshot fetch")));

    yield* must(shell, ["systemctl", "--user", "stop", nodeService]);
    yield* must(shell, ["systemctl", "--user", "stop", storeService]);
    const swapped = yield* Effect.exit(script("snapshot-restore", local));
    yield* startMailbox(shell);

    if (Exit.isFailure(swapped)) {
      return yield* Effect.failCause(swapped.cause);
    }

    yield* Effect.log(
      "MAILBOX_SNAPSHOT_RESTORED",
      source,
      swapped.value.trim()
    );

    return yield* Effect.void;
  }
);

export const restoreOwnedData = Effect.fn("MailboxRestore.restoreOwnedData")(
  function* restoreOwnedData(
    shell: Interface,
    dataRoot: string,
    request: RestoreRequest
  ) {
    yield* must(shell, [
      "python3",
      "-c",
      backupScript,
      "restore",
      dataRoot,
      request.backupRoot,
      request.source,
    ]);
    yield* Effect.log(
      "MAILBOX_DATA_RESTORED_IN_OWNED_DIRECTORIES",
      request.source
    );
  }
);
