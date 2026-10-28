import { Clock, Duration, Effect, Schema } from "effect";
import { transition } from "xstate";

import { HostError, must } from "../../packages/alchemy-nest/src/host-shell.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import { backupLifecycle } from "./backup-lifecycle.ts";
import { backupScript } from "./backup-script.ts";

export const BackupInput = Schema.Struct({
  backupRoot: Schema.String,
  commit: Schema.String,
  dataRoot: Schema.String,
  home: Schema.String,
  version: Schema.String,
});

export const storeService = "rat-king-seaweedfs.service";

export const nodeService = "rat-king-celld.service";

const ArchiveBytes = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

const PendingName = Schema.String.check(
  Schema.isPattern(/^\.mailbox-publish-\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{32}$/u)
);

const BackupName = Schema.String.check(
  Schema.isPattern(/^\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{32}$/u)
);

export const stepLimit = Duration.seconds(60);

export const snapshotLimit = Duration.seconds(60);

export const packLimit = Duration.minutes(45);

export const transferLimit = (bytes: number) =>
  Duration.seconds(120 + Math.ceil(bytes / 1_048_576));

const bounded = <A, E>(
  step: string,
  limit: Duration.Duration,
  effect: Effect.Effect<A, E>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: limit,
      orElse: () =>
        Effect.fail(
          new HostError({ operation: step, reason: "Backup step timed out" })
        ),
    }),
    Effect.tapError((failure) =>
      Effect.logError("BACKUP_STEP_FAILED", step, failure)
    )
  );

export const phase = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((began) =>
      effect.pipe(
        Effect.ensuring(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((ended) =>
              Effect.log("BACKUP_PHASE", name, ended - began)
            )
          )
        )
      )
    )
  );

export const startMailbox = (shell: Pick<Interface, "exec">) => {
  const ctl = (action: string, unit: string) =>
    must(shell, ["systemctl", "--user", action, unit]);

  return Effect.gen(function* startUnits() {
    yield* phase(
      "start-store",
      ctl("start", storeService).pipe(
        Effect.andThen(ctl("is-active", storeService))
      )
    );
    yield* phase(
      "start-node",
      ctl("start", nodeService).pipe(
        Effect.andThen(ctl("is-active", nodeService))
      )
    );
  });
};

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

  const memory = (moment: string) =>
    bounded("cgroup", stepLimit, script("cgroup")).pipe(
      Effect.flatMap((report) =>
        Effect.log("BACKUP_MEMORY", moment, report.trim())
      ),
      Effect.catchTag("HostError", (failure) =>
        Effect.logWarning("BACKUP_MEMORY_UNAVAILABLE", moment, failure)
      )
    );

  yield* Effect.log(
    (yield* bounded("prune-staging", stepLimit, script("prune-staging"))).trim()
  );
  yield* Effect.log(
    (yield* bounded("preflight", stepLimit, script("preflight"))).trim()
  );
  yield* ctl("is-active", storeService);
  yield* ctl("is-active", nodeService);
  const began = yield* Clock.currentTimeMillis;
  yield* Effect.acquireUseRelease(
    bounded("stage", stepLimit, script("stage")).pipe(
      Effect.map((path) => path.trim())
    ),
    (staging) =>
      Effect.gen(function* stagedBackup() {
        yield* checkpoint("ready");
        yield* memory("before-stop");

        const armed = yield* bounded(
          "arm",
          stepLimit,
          shell.exec([
            "python3",
            "-c",
            backupScript,
            "arm",
            input.dataRoot,
            input.backupRoot,
          ])
        );

        yield* Effect.log(armed.stdout.trim());

        yield* Effect.succeed(armed).pipe(
          Effect.filterOrFail(
            (result) => result.code === 0,
            () =>
              new HostError({
                operation: "arm",
                reason:
                  "Backup could not arm early-stop recovery; mailbox left running. Inspect backup unit age and the restart marker before retrying.",
              })
          )
        );

        const stoppedAt = yield* Clock.currentTimeMillis;

        yield* Effect.gen(function* quiesce() {
          yield* phase("stop-node", ctl("stop", nodeService));
          yield* phase("stop-store", ctl("stop", storeService));
          yield* checkpoint("stopped");
          yield* Effect.log(
            (yield* phase(
              "snapshot",
              bounded("snapshot", snapshotLimit, script("snapshot", staging))
            )).trim()
          );
          yield* checkpoint("copied");
          yield* startMailbox(shell);
          yield* script("disarm");
          yield* checkpoint("started");
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* recover() {
              yield* checkpoint("failed");
              yield* startMailbox(shell);
              yield* script("disarm");
              yield* checkpoint("recovered");
            }).pipe(
              Effect.catchTag("HostError", (error) =>
                Effect.logError("BACKUP_RECOVERY_FAILED", error)
              ),
              Effect.uninterruptible
            )
          )
        );
        yield* Effect.log(
          "BACKUP_STOP_MS",
          (yield* Clock.currentTimeMillis) - stoppedAt
        );

        yield* Effect.gen(function* publish() {
          yield* memory("publish-start");

          const bytes = yield* Schema.decodeEffect(ArchiveBytes)(
            (yield* bounded("pack", packLimit, script("pack", staging))).trim()
          );

          const transfer = transferLimit(bytes);

          yield* bounded(
            "local-gzip-test",
            transfer,
            must(shell, ["gzip", "-t", `${staging}/mailbox.tar.gz`])
          );

          const pending = yield* Schema.decodeEffect(PendingName)(
            (yield* bounded(
              "share-open",
              stepLimit,
              script("share-open")
            )).trim()
          );

          yield* bounded(
            "share-copy",
            transfer,
            script("share-copy", staging, pending)
          );
          yield* bounded(
            "share-manifest",
            stepLimit,
            script(
              "share-manifest",
              staging,
              pending,
              input.version,
              input.commit
            )
          );

          const name = yield* Schema.decodeEffect(BackupName)(
            (yield* bounded(
              "share-commit",
              stepLimit,
              script("share-commit", pending)
            )).trim()
          );

          yield* checkpoint("published");
          yield* bounded(
            "share-verify",
            transfer,
            script("share-verify", staging, name)
          );
          yield* bounded(
            "share-gzip-test",
            transfer,
            must(shell, [
              "gzip",
              "-t",
              `${input.backupRoot}/${name}/mailbox.tar.gz`,
            ])
          );
          yield* checkpoint("verified");
          yield* bounded(
            "cleanup",
            stepLimit,
            script("cleanup", staging, name)
          );
          yield* Effect.log("BACKUP_PUBLISHED", name);
        }).pipe(
          Effect.tapError(() => checkpoint("abandoned")),
          Effect.ensuring(memory("publish-end"))
        );
        yield* Effect.log(
          "BACKUP_DURATION_MS",
          (yield* Clock.currentTimeMillis) - began
        );
      }),
    (staging) =>
      bounded(
        "cleanup-staging",
        stepLimit,
        script("cleanup-staging", staging)
      ).pipe(Effect.orDie)
  );
});
