import { Effect, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { must } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { backupScript } from "./backup-script.ts";

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
