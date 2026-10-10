import { NodeServices } from "@effect/platform-node";
import { adopt } from "alchemy/AdoptPolicy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { localState } from "alchemy/State/LocalState";
import { Clock, Config, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { provision } from "../../apps/mailbox/cli/provision.ts";
import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import { Documents } from "../../apps/mailbox/src/auth.ts";
import { sidecarUnit } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import {
  deleteDirectory,
  reconcileDirectory,
  refuse,
} from "../../packages/alchemy-nest/src/files.ts";
import { HostShell, must } from "../../packages/alchemy-nest/src/host-shell.ts";
import { Host } from "../../packages/alchemy-nest/src/host.ts";
import { listenerProbe } from "../../packages/alchemy-nest/src/probes.ts";
import { stopUnits } from "../../packages/alchemy-nest/src/startup-contract.ts";
import { deleteDeclaredUnit } from "../../packages/alchemy-nest/src/systemd.ts";
import { removeStoreSockets } from "../../packages/alchemy-nest/src/unit-cleanup.ts";
import { stageName, workerIPv4, workerUrl } from "./config.ts";
import { assess, collectHealth, DigestJson } from "./health.ts";
import { isDeferredAdoption, qualifyRecoveryPlan } from "./recovery-plan.ts";
import { preflightRestore, restoreSnapshot } from "./restore.ts";
import { announceRestart } from "./ship-notice.ts";
import { sendShipNotification } from "./ship-notify.ts";
import { appendRestartEvent, guardRestartPlan } from "./ship-restart.ts";
import { stageShipUnits } from "./ship-unit-stage.ts";
import { connection, nestStack, nest } from "./stack.ts";
import { StageConfig } from "./stage-config.ts";

export const claudeMtimeScript = String.raw`
import glob, json, os, sys
home = sys.argv[1]
paths = sorted(set(glob.glob(home + "/.claude*") + [home + "/.local/bin/claude"]))
print(json.dumps({path: os.lstat(path).st_mtime_ns if os.path.lexists(path) else None for path in paths}))
`;

export type Action =
  | "stop"
  | "prepare"
  | "plan"
  | "deploy"
  | "backup"
  | "restore"
  | "restore-snapshot"
  | "listeners"
  | "destroy-plan"
  | "destroy"
  | "teardown-probe"
  | "recover-delete";

const requireFleet = (stage: string) =>
  stage === "fleet"
    ? Effect.void
    : refuse("Backup and restore require fleet stage");

const restoreBeforeGate = Effect.fn("Nest.restoreBeforeGate")(
  function* restoreBeforeGate(
    action: Action,
    stage: string,
    shell: Pick<typeof HostShell.Service, "exec">,
    dataRoot: string
  ) {
    if (action !== "restore-snapshot") {
      return yield* Effect.void;
    }

    yield* requireFleet(stage);

    if (!(yield* Config.Boolean("RAT_KING_START_APPROVED"))) {
      return yield* refuse("Host listener approval required");
    }

    return yield* restoreSnapshot(
      shell,
      dataRoot,
      yield* Config.String("RAT_KING_BACKUP_ROOT")
    );
  }
);

const beforeShipDeploy = Effect.fn("Ship.beforeDeploy")(
  function* beforeShipDeploy(
    action: Action,
    stack: typeof nest,
    stage: "proof" | "pilot" | "fleet"
  ) {
    if (
      action !== "deploy" ||
      !(yield* Config.Boolean("RAT_KING_SHIP_MODE").pipe(
        Config.withDefault(false)
      ))
    ) {
      return yield* Effect.void;
    }

    const planned = yield* evalStack(stack, (spec) => Plan.make(spec), {
      stage,
    }).pipe(adopt(true));

    const restarting = Plan.describePlan(planned).resources.some(
      (resource) =>
        resource.action !== "noop" &&
        (resource.resourceType === "Celld.Node" ||
          (resource.resourceType === "RatsNest.SystemdUnit" &&
            resource.fqn.endsWith("/store/server")))
    );

    if (!restarting) {
      return yield* Effect.void;
    }

    const shell = yield* HostShell;
    yield* guardRestartPlan(shell, true);

    const config = yield* Config.schema(
      Schema.fromJsonString(StageConfig),
      "RAT_KING_SHIP_CONFIG"
    );

    const attempt = config.shipAttempt;

    if (attempt === undefined) {
      return yield* refuse("Restart plan has no ship attempt");
    }

    yield* announceRestart(attempt, (text) =>
      sendShipNotification(config, text).pipe(
        Effect.provide(secretStoreLayer({}))
      )
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* noticeRefused() {
          yield* Effect.logError("SHIP_PRENOTICE_FAILED", error.reason);
          yield* appendRestartEvent(attempt, {
            durationSeconds: 0,
            phase: "deferred",
            restarted: false,
            retryAt: (yield* Clock.currentTimeMillis) / 1000 + 60,
          });

          return yield* refuse("Restart deferred because pre-notice failed");
        })
      )
    );

    yield* guardRestartPlan(shell, true);

    return yield* stageShipUnits(planned, shell);
  }
);

export const run = (action: Action) =>
  Effect.gen(function* runNestAction() {
    const stage = yield* stageName;

    if (action === "backup") {
      yield* requireFleet(stage);

      yield* must(yield* HostShell, [
        "systemctl",
        "--user",
        "start",
        "rat-king-mailbox-backup.service",
      ]);
      yield* Effect.log("MAILBOX_BACKUP_FINISHED");

      return yield* Effect.void;
    }

    if (action === "stop") {
      yield* must(yield* HostShell, [
        "systemctl",
        "--user",
        "stop",
        "rat-king-celld.service",
        "rat-king-seaweedfs.service",
      ]);
      yield* Effect.log("MAILBOX_STOPPED");

      return yield* Effect.void;
    }

    if (action === "recover-delete") {
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      yield* deleteDeclaredUnit(shell, sidecarUnit(host.home, ""));
      yield* removeStoreSockets(shell);
      yield* Effect.log("OWNED_RECOVERY_DELETE_PASSED");

      return yield* Effect.void;
    }

    if (action === "prepare") {
      const fs = yield* FileSystem.FileSystem;
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      if ((yield* must(shell, ["uname", "-m"])).trim() !== "x86_64") {
        return yield* refuse("Wrong deployment architecture");
      }

      const snapshotPath = `${yield* Config.String("RAT_KING_STATE_DIR")}/claude-mtimes.json`;

      if (yield* fs.exists(snapshotPath)) {
        return yield* refuse(
          "Claude mtime snapshot already exists; preserve it and use a fresh state directory"
        );
      }

      const snapshot = yield* must(shell, [
        "python3",
        "-c",
        claudeMtimeScript,
        host.home,
      ]);

      yield* fs.writeFileString(snapshotPath, snapshot, { mode: 0o600 });

      for (const directory of [
        `${host.home}/.local/share/rat-king`,
        `${host.home}/.local/share/rat-king/bin`,
      ]) {
        yield* reconcileDirectory(
          shell,
          { mode: 0o700, path: directory },
          undefined,
          true
        );
      }

      const cliPath = `${host.home}/.local/share/rat-king/bin/mailbox.mjs`;
      yield* shell.write({
        bytes: yield* fs.readFile(yield* Config.String("RAT_KING_CLI_OUTPUT")),
        mode: 0o600,
        path: cliPath,
      });

      if (stage !== "proof") {
        if (!(yield* fs.exists(yield* Config.String("RAT_KING_DOCUMENTS")))) {
          return yield* refuse(
            "Mailbox-only public operator documents must exist before prepare"
          );
        }

        yield* Effect.log("MAILBOX_ONLY_PREPARED");

        return yield* Effect.void;
      }

      const remote = yield* must(shell, [
        "node",
        cliPath,
        "identity",
        "--as",
        yield* Config.String("RAT_KING_REMOTE_AGENT"),
        "--did",
        yield* Config.String("RAT_KING_REMOTE_DID"),
      ]);

      const local = yield* provision(
        yield* Config.String("HOME"),
        yield* Config.String("RAT_KING_LOCAL_AGENT"),
        yield* Config.String("RAT_KING_LOCAL_DID")
      );

      const remoteDocuments = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Documents)
      )(`[${remote}]`);

      const documents = yield* Schema.decodeUnknownEffect(Documents)([
        local,
        ...remoteDocuments,
      ]);

      yield* fs.writeFileString(
        yield* Config.String("RAT_KING_DOCUMENTS"),
        JSON.stringify(documents),
        { mode: 0o600 }
      );
      yield* Effect.log("PROOF_IDENTITIES_READY");

      return yield* Effect.void;
    }

    if (["listeners", "restore-snapshot"].includes(action)) {
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      yield* restoreBeforeGate(action, stage, shell, host.dataRoot);

      const sidecar = yield* Config.Boolean("RAT_KING_CLAUDE_SIDECAR").pipe(
        Config.withDefault(false)
      );

      yield* Effect.log(
        yield* listenerProbe(
          shell,
          workerIPv4(stage, host),
          true,
          sidecar
        ).pipe(
          Effect.onError(() =>
            stopUnits(shell, [
              "rat-king-celld.service",
              "rat-king-seaweedfs.service",
              "rat-king-claude-sidecar.service",
            ]).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logError("LISTENER_CLEANUP_FAILED", error),
                onSuccess: () => Effect.void,
              })
            )
          )
        )
      );

      return yield* Effect.void;
    }

    if (action === "teardown-probe") {
      const fs = yield* FileSystem.FileSystem;
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      const script = yield* fs.readFileString(
        new URL("teardown-probe.py", import.meta.url).pathname
      );

      const result = yield* shell.exec([
        "python3",
        "-c",
        script,
        host.home,
        host.dataRoot,
        yield* fs.readFileString(
          `${yield* Config.String("RAT_KING_STATE_DIR")}/claude-mtimes.json`
        ),
      ]);

      yield* Effect.log(result.stdout);

      if (result.code !== 0) {
        return yield* refuse(
          "Teardown probe failed; retain state and report leftovers"
        );
      }

      return yield* Effect.void;
    }

    if (action === "destroy-plan") {
      const plan = yield* evalStack(nest, (stack) => Plan.destroy(stack), {
        stage,
      });

      yield* Effect.log(JSON.stringify(Plan.describePlan(plan)));
      yield* Effect.log(
        "EXPLICIT_OWNED_DELETE: configuration/agents (provisioned proof keys)"
      );

      return yield* Effect.void;
    }

    if (action === "destroy") {
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      yield* deleteDirectory(shell, {
        mode: 0o700,
        path: `${host.home}/.config/rat-king/agents`,
        purgeRoot: `${host.home}/.config/rat-king`,
      });
      yield* destroy({ stack: nest, stage });
      yield* Effect.log("MAILBOX_DESTROYED");

      return yield* Effect.void;
    }

    if (action === "plan") {
      const plan = yield* evalStack(nest, (stack) => Plan.make(stack), {
        stage,
      }).pipe(adopt(true));

      yield* qualifyRecoveryPlan(plan);
      const summary = Plan.describePlan(plan);

      const actions = Object.values(summary.resources).map(
        (resource) => resource.action
      );

      if (actions.some((entry) => entry === "delete" || entry === "replace")) {
        return yield* refuse("POC plan refuses delete or replace");
      }

      yield* Effect.log(
        JSON.stringify({
          actions,
          noop: actions.every((entry) => entry === "noop"),
          resources: summary.resources.map((row) => ({
            ...row,
            recovery: isDeferredAdoption(plan, row.fqn)
              ? "deferred-adoption"
              : row.action,
          })),
        })
      );

      return yield* Effect.void;
    }

    if (!(yield* Config.Boolean("RAT_KING_START_APPROVED"))) {
      return yield* refuse("Host listener approval required");
    }

    const fs = yield* FileSystem.FileSystem;

    if (
      !(yield* fs.exists(
        `${yield* Config.String("RAT_KING_STATE_DIR")}/claude-mtimes.json`
      ))
    ) {
      return yield* refuse("Prepare must record Claude mtimes before deploy");
    }

    const stack =
      action === "restore"
        ? yield* Effect.gen(function* restoreStack() {
            yield* requireFleet(stage);

            const target = yield* (yield* Host).node(
              yield* Config.String("RAT_KING_LIVE_NODE")
            );

            const request = yield* preflightRestore(
              yield* HostShell,
              target.dataRoot,
              yield* Config.String("RAT_KING_BACKUP_ROOT")
            );

            return nestStack(request);
          })
        : nest;

    yield* beforeShipDeploy(action, stack, stage);

    yield* deploy({ stack, stage }).pipe(adopt(true));
    const shell = yield* HostShell;

    const host = yield* (yield* Host).node(
      yield* Config.String("RAT_KING_LIVE_NODE")
    );

    const sidecar = yield* Config.Boolean("RAT_KING_CLAUDE_SIDECAR").pipe(
      Config.withDefault(false)
    );

    yield* listenerProbe(shell, workerIPv4(stage, host), true, sidecar).pipe(
      Effect.onError(() =>
        stopUnits(shell, [
          "rat-king-celld.service",
          "rat-king-seaweedfs.service",
          "rat-king-claude-sidecar.service",
        ]).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logError("LISTENER_CLEANUP_FAILED", error),
            onSuccess: () => Effect.void,
          })
        )
      )
    );
    yield* Effect.log("MAILBOX_DEPLOYED");

    return yield* Effect.void;
  }).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        connection.pipe(Layer.provide(NodeServices.layer)),
        Layer.mergeAll(
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        ).pipe(Layer.provide(NodeServices.layer))
      )
    )
  );

export const healthDigest = (previous: string | undefined) =>
  Effect.gen(function* collectNestHealth() {
    const stage = yield* stageName;

    const prior =
      previous === undefined
        ? undefined
        : yield* Schema.decodeEffect(DigestJson)(previous).pipe(
            Effect.mapError(() => refuse("Previous digest is malformed"))
          );

    const host = yield* (yield* Host).node(
      yield* Config.String("RAT_KING_LIVE_NODE")
    );

    const facts = yield* collectHealth(yield* HostShell, {
      backupRoot: yield* Config.String("RAT_KING_BACKUP_ROOT"),
      bucket: yield* Config.String("RAT_KING_BUCKET").pipe(
        Config.withDefault("rat-king-cells")
      ),
      dataRoot: host.dataRoot,
      healthUrl: `${workerUrl(stage, host)}/.well-known/celld/health`,
      home: host.home,
      publicIPv4: workerIPv4(stage, host),
      sidecar: yield* Config.Boolean("RAT_KING_CLAUDE_SIDECAR").pipe(
        Config.withDefault(false)
      ),
    });

    return { ...facts, ...assess(facts, prior) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        connection.pipe(Layer.provide(NodeServices.layer))
      )
    )
  );
