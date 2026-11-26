import { Stack } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, FileSystem, Option, Schema } from "effect";

import { Documents } from "../../apps/mailbox/src/auth.ts";
import { hostedVars } from "../../apps/mailbox/src/bindings.ts";
import {
  RuntimeFiles,
  sidecarUnit,
} from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import type { RuntimeFilesProps } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { stageDeploymentFiles } from "../../packages/alchemy-nest/src/deployment-stage.ts";
import { Deployment } from "../../packages/alchemy-nest/src/deployment.ts";
import type { DeploymentProps } from "../../packages/alchemy-nest/src/deployment.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import {
  RemoteFile,
  SystemdUnit,
} from "../../packages/alchemy-nest/src/providers.ts";
import { backupTimer, backupUnit } from "./backup-units.ts";
import { fleetCelldBinary } from "./celld-build.ts";
import { mailboxCliEnvironment } from "./cli-environment.ts";
import { celldMemoryMax, configuration, stageName } from "./config.ts";
import { fleetStoreCredentials } from "./credentials.ts";
import { deploymentPayloads } from "./deploy-payloads.ts";
import { nestProviders } from "./nest-providers.ts";
import type { PreparedFleetPayload } from "./prepared-payload.ts";
import type { RestoreRequest } from "./restore.ts";
import { fleetMemoryLimits } from "./stop-memory.ts";

export { connection } from "./nest-providers.ts";

const delegationVars = Config.Boolean("RAT_KING_DELEGATION").pipe(
  Config.withDefault(false),
  Config.map((enabled) => (enabled ? { DELEGATION: "true" } : {}))
);

const healthReaderVars = Config.schema(
  Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
  "RAT_KING_HEALTH_READER_DIDS"
).pipe(
  Config.withDefault([]),
  Config.map((dids) => ({ HEALTH_READER_DIDS: JSON.stringify(dids) }))
);

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

export const nestStack = (
  restore?: RestoreRequest,
  payload?: PreparedFleetPayload,
  providers = nestProviders(restore, payload)
) =>
  Stack(
    "nest",
    providers,
    Effect.gen(function* nest() {
      const fs = yield* FileSystem.FileSystem;
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

      const views = yield* Config.option(
        Config.String("RAT_KING_NAME_STATE_VIEWS")
      );

      if (Option.isSome(views)) {
        Object.assign(vars, { NAME_STATE_VIEWS: views.value });
      }

      Object.assign(vars, yield* delegationVars);

      Object.assign(vars, yield* healthReaderVars);

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

      const bundles = yield* deploymentPayloads(
        fleet,
        mailboxOnly,
        vars,
        payload
      );

      const { deployment: prepared } = bundles;

      const staged = yield* stageDeploymentFiles(
        node.home,
        prepared,
        mailboxOnly
      );

      const slice = yield* ObjectStore.Slice(node.home, memoryMax, cpuQuota);

      const bucket = yield* ObjectStore.Bucket("store", {
        ...(yield* fleetStoreCredentials()),
        host: node,
        memoryMax: fleetMemoryLimits.seaweedfs,
        name: yield* Config.String("RAT_KING_BUCKET").pipe(
          Config.withDefault("rat-king-cells")
        ),
        prepared: staged,
        purgeOnDelete: !recoverState,
        restartGateBundle: bundles.restart,
        slice: slice.sha256,
        volumeMax: 2048,
      });

      const cells = yield* Celld.Node("celld", {
        binary: fleetCelldBinary(node.home),
        bucket,
        host: node,
        memoryMax: celldMemoryMax(node),
        prepared: staged,
        purgeOnDelete: !recoverState,
        tuning: { CELLD_LTX_LOCAL_L0_KEEP: "32" },
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
        content: bundles.cli,
        mode: 0o600,
        path: Output.interpolate`${bucket.bin}/mailbox.mjs`,
      });

      yield* RemoteFile("mailbox-documents", {
        content: documents,
        mode: 0o600,
        path: Output.interpolate`${bucket.configuration}/proof.documents.json`,
      });

      yield* RemoteFile("mailbox-cli-environment", {
        content: mailboxCliEnvironment({
          home: node.home,
          serviceDid,
          workerUrl,
        }),
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

      if (bundles.backup !== undefined) {
        const backupRoot = yield* Config.String("RAT_KING_BACKUP_ROOT");

        const backup = yield* RemoteFile("mailbox-backup-runner", {
          content: bundles.backup,
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
                commit: prepared.commit,
                dataRoot: node.dataRoot,
                healthUrl: `${workerUrl}/.well-known/celld/health`,
                home: node.home,
                ready,
                version: prepared.version,
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
