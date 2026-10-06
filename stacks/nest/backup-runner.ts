import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { localExec } from "../../packages/alchemy-nest/src/local-exec.ts";
import { BackupInput, runBackup } from "./backup.ts";

const program = Effect.gen(function* backupMain() {
  const [dataRoot, backupRoot, version, commit, home] = process.argv.slice(2);

  const input = yield* Schema.decodeUnknownEffect(BackupInput)({
    backupRoot,
    commit,
    dataRoot,
    home,
    version,
  });

  yield* runBackup(yield* localExec, input);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
