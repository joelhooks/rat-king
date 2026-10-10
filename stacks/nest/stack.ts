import { Stack, localState } from "alchemy";
import * as Output from "alchemy/Output";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";

import { Documents } from "../../apps/mailbox/src/auth.ts";
import {
  bindings,
  hostedBindings,
  hostedVars,
} from "../../apps/mailbox/src/bindings.ts";
import { StateRecovery } from "../../packages/alchemy-nest/src/adoption.ts";
import {
  RuntimeFiles,
  RuntimeFilesProvider,
  sidecarUnit,
} from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import type { RuntimeFilesProps } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import { stageDeploymentFiles } from "../../packages/alchemy-nest/src/deployment-stage.ts";
import {
  Deployment,
  DeploymentProvider,
} from "../../packages/alchemy-nest/src/deployment.ts";
import type { DeploymentProps } from "../../packages/alchemy-nest/src/deployment.ts";
import { offlineLayer } from "../../packages/alchemy-nest/src/fake-shell.ts";
import { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import {
  operatorBundle,
  optionalOperatorBundle,
} from "../../packages/alchemy-nest/src/operator-build.ts";
import {
  RemoteFile,
  SystemdUnit,
} from "../../packages/alchemy-nest/src/providers.ts";
import { sourceLayer } from "../../packages/alchemy-nest/src/release.ts";
import {
  shellQuote,
  layer as sshLayer,
} from "../../packages/alchemy-nest/src/ssh.ts";
import { startupLayer } from "../../packages/alchemy-nest/src/startup-contract.ts";
import { backupTimer, backupUnit } from "./backup-units.ts";
import {
  configuration,
  stageName,
  workerIPv4 as stageWorkerIPv4,
} from "./config.ts";
import { restoreOwnedData } from "./restore.ts";
import type { RestoreRequest } from "./restore.ts";
import { guardedShell } from "./ship-restart.ts";

const issuerVars = Effect.gen(function* readIssuerVars() {
  const template = yield* Config.option(
    Config.schema(Schema.NonEmptyString, "RAT_KING_ISSUER_DID_TEMPLATE")
  );

  const reserved = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
    "RAT_KING_ISSUER_RESERVED"
  ).pipe(Config.withDefault([]));

  return Option.match(template, {
    onNone: () => ({}),
    onSome: (value) => ({
      ISSUER_DID_TEMPLATE: value,
      ISSUER_RESERVED: JSON.stringify(reserved),
    }),
  });
});

export const connection = Layer.unwrap(
  Effect.gen(function* connection() {
    const hosts = yield* Host;

    if (
      yield* Config.Boolean("RAT_KING_OFFLINE_PLAN").pipe(
        Config.withDefault(false)
      )
    ) {
      return offlineLayer;
    }

    const target = yield* hosts.node(
      yield* Config.String("RAT_KING_LIVE_NODE")
    );

    return Layer.effect(
      HostShell,
      Effect.gen(function* shipConnection() {
        return yield* guardedShell(yield* HostShell);
      })
    ).pipe(Layer.provide(sshLayer(target)));
  })
).pipe(Layer.provideMerge(inventoryLayer), Layer.orDie);

const startup = (restore?: RestoreRequest) =>
  Layer.unwrap(
    Effect.gen(function* startupPorts() {
      const hosts = yield* Host;

      const stage = yield* stageName;

      const node = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      return startupLayer(
        stageWorkerIPv4(stage, node),
        stage === "pilot" ? "service" : "scope",
        stage === "fleet"
          ? `${node.dataRoot}/.mailbox-restore-objects.tar`
          : undefined,
        restore === undefined
          ? undefined
          : restoreOwnedData(yield* HostShell, node.dataRoot, restore)
      );
    })
  ).pipe(Layer.provide(connection), Layer.orDie);

const stateRecovery = Effect.fn("Nest.stateRecovery")(function* stateRecovery(
  mailboxOnly: boolean
) {
  const enabled = yield* Config.Boolean("RAT_KING_RECOVER_STATE").pipe(
    Config.withDefault(false)
  );

  if (enabled && !mailboxOnly) {
    return yield* Effect.die(
      "State recovery currently supports mailbox-only stages"
    );
  }

  return enabled;
});

export const nestStack = (restore?: RestoreRequest) =>
  Stack(
    "nest",
    {
      providers: Layer.mergeAll(
        ObjectStore.providers(),
        Celld.providers(),
        DeploymentProvider(),
        RuntimeFilesProvider()
      ).pipe(
        Layer.provide(
          Layer.effect(
            StateRecovery,
            Config.Boolean("RAT_KING_RECOVER_STATE").pipe(
              Config.withDefault(false),
              Effect.orDie
            )
          )
        ),
        Layer.provide(startup(restore)),
        Layer.provide(connection),
        Layer.provide(sourceLayer.pipe(Layer.orDie)),
        Layer.provide(FetchHttpClient.layer)
      ),
      state: localState(),
    },
    Effect.gen(function* nest() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hosts = yield* Host;

      const node = yield* hosts
        .node(yield* Config.String("RAT_KING_LIVE_NODE"))
        .pipe(Effect.orDie);

      const {
        cpuQuota,
        gatewayUrl,
        hostedDid,
        memoryMax,
        mode,
        model,
        mailboxOnly,
        remoteAgent,
        secretName,
        sidecar,
        sidecarBundle,
        workerIPv4,
        workerUrl,
      } = yield* configuration(node);

      const fleet = (yield* stageName) === "fleet";

      const recoverState = yield* stateRecovery(mailboxOnly);

      const documents = yield* fs.readFileString(
        yield* Config.String("RAT_KING_DOCUMENTS")
      );

      const version = yield* Config.String("RAT_KING_VERSION");
      const commit = yield* Config.String("RAT_KING_COMMIT");
      const serviceDid = yield* Config.String("RAT_KING_SERVICE_DID");

      const vars = mailboxOnly
        ? { DID_DOCUMENTS: documents, SERVICE_DID: serviceDid }
        : hostedVars({
            documents,
            gatewayModel: model,
            gatewayUrl,
            hostedDid,
            model: mode,
            serviceDid,
            sidecar,
          });

      const operators = yield* Config.schema(
        Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
        "RAT_KING_OPERATOR_DIDS"
      ).pipe(Config.withDefault([]));

      const observers = yield* Config.schema(
        Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
        "RAT_KING_OBSERVER_DIDS"
      ).pipe(Config.withDefault([]));

      const resolvers = yield* Config.schema(
        Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
        "RAT_KING_LEASE_RESOLVERS"
      ).pipe(Config.withDefault([]));

      Object.assign(vars, yield* issuerVars);

      if (mailboxOnly) {
        const publicDocuments = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Documents)
        )(documents);

        if (
          operators.length === 0 ||
          operators.some(
            (did) => !publicDocuments.some((document) => document.id === did)
          )
        ) {
          return yield* Effect.die(
            "Mailbox-only stages require static public documents for every operator DID"
          );
        }
      }

      if (
        mailboxOnly ||
        operators.length > 0 ||
        observers.length > 0 ||
        resolvers.length > 0
      ) {
        Object.assign(vars, {
          LEASE_RESOLVERS: JSON.stringify(resolvers),
          OBSERVER_DIDS: JSON.stringify(observers),
          OPERATOR_DIDS: JSON.stringify(operators),
        });
      }

      const prepared = yield* prepareDeployment(
        path.resolve(
          import.meta.dirname,
          mailboxOnly
            ? "../../apps/mailbox/src/worker.ts"
            : "../../apps/mailbox/src/hosted-worker.ts"
        ),
        mailboxOnly ? bindings : hostedBindings,
        {
          commit,
          vars,
          version,
        }
      );

      const staged = yield* stageDeploymentFiles(
        node.home,
        prepared,
        mailboxOnly
      );

      const restartGateBundle = Option.getOrUndefined(
        yield* optionalOperatorBundle(
          fleet,
          path.resolve(import.meta.dirname, "restart-gate.ts")
        )
      );

      const slice = yield* ObjectStore.Slice(node.home, memoryMax, cpuQuota);

      const bucket = yield* ObjectStore.Bucket("store", {
        host: node,
        name: yield* Config.String("RAT_KING_BUCKET").pipe(
          Config.withDefault("rat-king-cells")
        ),
        prepared: staged,
        purgeOnDelete: !recoverState,
        restartGateBundle,
        slice: slice.sha256,
      });

      const cells = yield* Celld.Node("celld", {
        bucket,
        host: node,
        prepared: staged,
        purgeOnDelete: !recoverState,
        workerIPv4,
      });

      const runtime = mailboxOnly
        ? undefined
        : yield* RuntimeFiles(
            "agent-runtime-files",
            Output.all(cells.unit.sha256).pipe(
              Output.map(
                ([ready]) =>
                  ({
                    agent: remoteAgent,
                    did: hostedDid,
                    gatewayUrl,
                    home: node.home,
                    mode,
                    ready,
                    secretName,
                    sidecar,
                    sidecarBundle,
                  }) satisfies RuntimeFilesProps
              )
            )
          );

      const sidecarReady = sidecar
        ? (yield* SystemdUnit(
            "claude-sidecar",
            (runtime?.sha256 ?? cells.unit.sha256).pipe(
              Output.map((ready) => sidecarUnit(node.home, ready))
            )
          )).sha256
        : (runtime?.sha256 ?? cells.unit.sha256);

      const cli = yield* RemoteFile("mailbox-cli", {
        content: yield* fs.readFileString(
          yield* Config.String("RAT_KING_CLI_OUTPUT")
        ),
        mode: 0o600,
        path: Output.interpolate`${bucket.bin}/mailbox.mjs`,
      });

      yield* RemoteFile("mailbox-documents", {
        content: documents,
        mode: 0o600,
        path: Output.interpolate`${bucket.configuration}/proof.documents.json`,
      });

      yield* RemoteFile("mailbox-cli-environment", {
        content: `export RAT_KING_DOCUMENTS=${shellQuote(`${node.home}/.config/rat-king/proof.documents.json`)}\nexport RAT_KING_ENDPOINT=${shellQuote(workerUrl)}\nexport RAT_KING_SERVICE_DID=${shellQuote(serviceDid)}\n`,
        mode: 0o600,
        path: Output.interpolate`${bucket.configuration}/proof.env`,
      });

      const deployment = yield* Deployment(
        "mailbox",
        Output.all(
          cells.publicUrl,
          cells.internalUrl,
          bucket.configuration,
          cli.sha256,
          cells.unit.sha256,
          runtime?.bindings ?? cells.unit.sha256.pipe(Output.map(() => "")),
          sidecarReady,
          ...staged
        ).pipe(
          Output.map((values) => {
            const props: DeploymentProps = {
              ...prepared,
              binary: `${node.home}/.local/share/rat-king/bin/celld`,
              directory: `${values[2]}/mailbox-deployment`,
              environmentFile: `${values[2]}/celld.env`,
              internalUrl: values[1],
              workerUrl: values[0],
            };

            if (!mailboxOnly) {
              return { ...props, bindingsFile: values[5] };
            }

            return props;
          })
        )
      );

      if (fleet) {
        const backupRoot = yield* Config.String("RAT_KING_BACKUP_ROOT");

        const backup = yield* RemoteFile("mailbox-backup-runner", {
          content: yield* operatorBundle(
            path.resolve(import.meta.dirname, "backup-runner.ts")
          ),
          mode: 0o600,
          path: Output.interpolate`${bucket.bin}/mailbox-backup.mjs`,
        });

        const backupLock = yield* RemoteFile("mailbox-backup-lock", {
          content: "",
          mode: 0o600,
          path: Output.interpolate`${bucket.configuration}/mailbox-backup.lock`,
        });

        const backupService = yield* SystemdUnit(
          "mailbox-backup-service",
          Output.all(backup.sha256, deployment.commit, backupLock.sha256).pipe(
            Output.map(([ready]) =>
              backupUnit({
                backupRoot,
                commit,
                dataRoot: node.dataRoot,
                home: node.home,
                ready,
                version,
              })
            )
          )
        );

        yield* SystemdUnit(
          "mailbox-backup-timer",
          backupService.sha256.pipe(
            Output.map((ready) => backupTimer(node.home, ready))
          )
        );
      }

      return {
        commit: deployment.commit,
        version: deployment.version,
        workerUrl: deployment.workerUrl,
      };
    }).pipe(Effect.provide(inventoryLayer), Effect.orDie)
  );

export const nest = nestStack();
