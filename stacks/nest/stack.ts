import { Stack, localState } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { Documents } from "../../apps/mailbox/src/auth.ts";
import {
  bindings,
  hostedBindings,
  hostedVars,
} from "../../apps/mailbox/src/bindings.ts";
import {
  RuntimeFiles,
  RuntimeFilesProvider,
  sidecarUnit,
} from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import type { RuntimeFilesProps } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import {
  Deployment,
  DeploymentProvider,
} from "../../packages/alchemy-nest/src/deployment.ts";
import type { DeploymentProps } from "../../packages/alchemy-nest/src/deployment.ts";
import { offlineLayer } from "../../packages/alchemy-nest/src/fake-shell.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
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
import {
  configuration,
  stageName,
  workerIPv4 as stageWorkerIPv4,
} from "./config.ts";

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

    return sshLayer(
      yield* hosts.node(yield* Config.String("RAT_KING_LIVE_NODE"))
    );
  })
).pipe(Layer.provideMerge(inventoryLayer), Layer.orDie);

const startup = Layer.unwrap(
  Effect.gen(function* startup() {
    const hosts = yield* Host;

    const stage = yield* stageName;

    return startupLayer(
      stageWorkerIPv4(
        stage,
        yield* hosts.node(yield* Config.String("RAT_KING_LIVE_NODE"))
      ),
      stage === "pilot" ? "service" : "scope"
    );
  })
).pipe(Layer.provide(connection), Layer.orDie);

export const nest = Stack(
  "nest",
  {
    providers: Layer.mergeAll(
      ObjectStore.providers(),
      Celld.providers(),
      DeploymentProvider(),
      RuntimeFilesProvider()
    ).pipe(
      Layer.provide(startup),
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
      pilot,
      remoteAgent,
      secretName,
      sidecar,
      sidecarBundle,
      workerIPv4,
      workerUrl,
    } = yield* configuration(node);

    const slice = yield* ObjectStore.Slice(node.home, memoryMax, cpuQuota);

    const bucket = yield* ObjectStore.Bucket("store", {
      host: node,
      name: yield* Config.String("RAT_KING_BUCKET").pipe(
        Config.withDefault("rat-king-cells")
      ),
      purgeOnDelete: true,
      slice: slice.sha256,
    });

    const cells = yield* Celld.Node("celld", {
      bucket,
      host: node,
      purgeOnDelete: true,
      workerIPv4,
    });

    const runtime = pilot
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

    const documents = yield* fs.readFileString(
      yield* Config.String("RAT_KING_DOCUMENTS")
    );

    const version = yield* Config.String("RAT_KING_VERSION");
    const commit = yield* Config.String("RAT_KING_COMMIT");
    const serviceDid = yield* Config.String("RAT_KING_SERVICE_DID");

    const vars = pilot
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

    const resolvers = yield* Config.schema(
      Schema.fromJsonString(Schema.Array(Schema.NonEmptyString)),
      "RAT_KING_LEASE_RESOLVERS"
    ).pipe(Config.withDefault([]));

    if (pilot) {
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
          "Pilot requires static public documents for every operator DID"
        );
      }
    }

    if (pilot || operators.length > 0 || resolvers.length > 0) {
      Object.assign(vars, {
        LEASE_RESOLVERS: JSON.stringify(resolvers),
        OPERATOR_DIDS: JSON.stringify(operators),
      });
    }

    const prepared = yield* prepareDeployment(
      path.resolve(
        import.meta.dirname,
        pilot
          ? "../../apps/mailbox/src/worker.ts"
          : "../../apps/mailbox/src/hosted-worker.ts"
      ),
      pilot ? bindings : hostedBindings,
      {
        commit,
        vars,
        version,
      }
    );

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
        sidecarReady
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

          if (!pilot) {
            return { ...props, bindingsFile: values[5] };
          }

          return props;
        })
      )
    );

    return {
      commit: deployment.commit,
      version: deployment.version,
      workerUrl: deployment.workerUrl,
    };
  }).pipe(Effect.provide(inventoryLayer), Effect.orDie)
);
