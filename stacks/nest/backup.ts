import { Clock, Effect, Schema } from "effect";
import { transition } from "xstate";

import { must } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { s3Script } from "../../packages/alchemy-nest/src/s3-script.ts";
import { backupLifecycle } from "./backup-lifecycle.ts";
import { backupScript } from "./backup-script.ts";

export const BackupInput = Schema.Struct({
  backupRoot: Schema.String,
  commit: Schema.String,
  dataRoot: Schema.String,
  home: Schema.String,
  version: Schema.String,
});

export const runBackup = Effect.fn("Nest.backup")(function* runBackup(
  shell: Pick<Interface, "exec">,
  input: typeof BackupInput.Type
) {
  let state = backupLifecycle.resolveState({ context: {}, value: "preflight" });

  const checkpoint = (type: string) =>
    Effect.gen(function* advance() {
      const [next] = transition(backupLifecycle, state, { type });
      state = next;
      yield* Effect.log("BACKUP_STATE", state.value);
    });

  const ctl = (action: string, unit: string) =>
    must(shell, ["systemctl", "--user", action, unit]);

  const script = (action: string, ...args: readonly string[]) =>
    must(shell, [
      "python3",
      "-c",
      backupScript,
      action,
      input.dataRoot,
      input.backupRoot,
      ...args,
    ]);

  yield* script("preflight");
  yield* ctl("is-active", "rat-king-seaweedfs.service");
  yield* ctl("is-active", "rat-king-celld.service");
  const began = yield* Clock.currentTimeMillis;
  yield* checkpoint("ready");
  yield* Effect.gen(function* quiesceSnapshotPublish() {
    yield* ctl("stop", "rat-king-celld.service");
    yield* checkpoint("stopped");
    const staging = (yield* script("stage")).trim();
    yield* must(shell, [
      "python3",
      "-c",
      s3Script,
      `${input.home}/.config/rat-king/s3.json`,
      "http://127.0.0.1:18333",
      "@environment",
      "export",
      `${staging}/objects.tar`,
    ]);
    yield* checkpoint("exported");
    yield* script("snapshot", staging);
    yield* checkpoint("copied");
    yield* ctl("start", "rat-king-celld.service");
    yield* checkpoint("started");
    yield* Effect.log(
      "BACKUP_QUIESCE_MS",
      (yield* Clock.currentTimeMillis) - began
    );
    yield* Effect.log(
      (yield* script("publish", staging, input.version, input.commit)).trim()
    );
    yield* checkpoint("published");
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* recover() {
        const restartRefused = state.matches("restartingCelld");

        yield* checkpoint("failed");

        if (restartRefused) {
          yield* must(shell, [
            "systemctl",
            "--user",
            "stop",
            "rat-king-celld.service",
            "rat-king-seaweedfs.service",
          ]);
          yield* checkpoint("refused");
        } else {
          yield* ctl("start", "rat-king-celld.service");
          yield* checkpoint("recovered");
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("BACKUP_RECOVERY_FAILED", error)
        )
      )
    )
  );
  yield* Effect.log(
    "BACKUP_DURATION_MS",
    (yield* Clock.currentTimeMillis) - began
  );
});
