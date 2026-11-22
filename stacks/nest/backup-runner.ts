import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { backupExec } from "./backup-exec.ts";
import { BackupInput, runBackup } from "./backup.ts";

export const program = Effect.gen(function* backupMain() {
  const [dataRoot, backupRoot, version, commit, home, healthUrl] =
    process.argv.slice(2);

  const input = yield* Schema.decodeUnknownEffect(BackupInput)({
    backupRoot,
    commit,
    dataRoot,
    healthUrl,
    home,
    version,
  });

  yield* runBackup(yield* backupExec, input);
});

if (import.meta.main) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
