import { Stack, localState } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/http";

import { hostedBindings, hostedVars } from "../../apps/mailbox/src/bindings.ts";
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

    return startupLayer(
      (yield* hosts.node(yield* Config.String("RAT_KING_LIVE_NODE")))
        .tailnetIPv4
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

    const mode = yield* Config.String("RAT_KING_AGENT_MODEL").pipe(
      Config.withDefault("faux")
    );

    if (mode !== "faux" && mode !== "gateway") {
      return yield* Effect.die("Unknown hosted agent mode");
    }

    const sidecar = yield* Config.Boolean("RAT_KING_CLAUDE_SIDECAR").pipe(
      Config.withDefault(false)
    );

    const model = yield* Config.String("MODEL_GATEWAY_MODEL").pipe(
      Config.withDefault("gpt-6-sol")
    );

    if (
      (model !== "gpt-6-sol" && model !== "claude-opus-5-5") ||
      (model === "claude-opus-5-5" && !sidecar) ||
      (mode === "faux" && sidecar)
    ) {
      return yield* Effect.die("Unsupported hosted model configuration");
    }

    const hostedDid = yield* Config.String("RAT_KING_REMOTE_DID");

    const gatewayUrl =
      mode === "gateway" ? yield* Config.String("MODEL_GATEWAY_BASE_URL") : "";

    const slice = yield* ObjectStore.Slice(
      node.home,
      yield* Config.String("RAT_KING_SLICE_MEMORY_MAX").pipe(
        Config.withDefault("4G")
      )
    );

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
    });

    const remoteAgent = yield* Config.String("RAT_KING_REMOTE_AGENT");

    const secretName =
      mode === "gateway"
        ? yield* Config.String("RAT_KING_MODEL_GATEWAY_SECRET_NAME")
        : "";

    const sidecarBundle = sidecar
      ? yield* fs.readFileString(
          yield* Config.String("RAT_KING_SIDECAR_OUTPUT")
        )
      : "";

    const runtime = yield* RuntimeFiles(
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
          runtime.sha256.pipe(
            Output.map((ready) => sidecarUnit(node.home, ready))
          )
        )).sha256
      : runtime.sha256;

    const documents = yield* fs.readFileString(
      yield* Config.String("RAT_KING_DOCUMENTS")
    );

    const version = yield* Config.String("RAT_KING_VERSION");
    const commit = yield* Config.String("RAT_KING_COMMIT");
    const serviceDid = yield* Config.String("RAT_KING_SERVICE_DID");

    const vars = hostedVars({
      documents,
      gatewayModel: model,
      gatewayUrl,
      hostedDid,
      model: mode,
      serviceDid,
      sidecar,
    });

    const prepared = yield* prepareDeployment(
      path.resolve(
        import.meta.dirname,
        "../../apps/mailbox/src/hosted-worker.ts"
      ),
      hostedBindings,
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
      content: `export RAT_KING_DOCUMENTS=${shellQuote(`${node.home}/.config/rat-king/proof.documents.json`)}\nexport RAT_KING_ENDPOINT=${shellQuote(`http://${node.tailnetIPv4}:18787`)}\nexport RAT_KING_SERVICE_DID=${shellQuote(serviceDid)}\n`,
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
        runtime.bindings,
        sidecarReady
      ).pipe(
        Output.map((values) => ({
          ...prepared,
          binary: `${node.home}/.local/share/rat-king/bin/celld`,
          bindingsFile: values[5],
          directory: `${values[2]}/mailbox-deployment`,
          environmentFile: `${values[2]}/celld.env`,
          internalUrl: values[1],
          workerUrl: values[0],
        }))
      )
    );

    return {
      commit: deployment.commit,
      version: deployment.version,
      workerUrl: deployment.workerUrl,
    };
  }).pipe(Effect.provide(inventoryLayer), Effect.orDie)
);
