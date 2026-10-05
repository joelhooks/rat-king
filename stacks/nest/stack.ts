import { Stack, localState } from "alchemy";
import * as Output from "alchemy/Output";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/http";

import { bindings } from "../../apps/mailbox/src/bindings.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import {
  Deployment,
  DeploymentProvider,
} from "../../packages/alchemy-nest/src/deployment.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import { RemoteFile } from "../../packages/alchemy-nest/src/providers.ts";
import { sourceLayer } from "../../packages/alchemy-nest/src/release.ts";
import {
  shellQuote,
  layer as sshLayer,
} from "../../packages/alchemy-nest/src/ssh.ts";
import { startupLayer } from "../../packages/alchemy-nest/src/startup-contract.ts";

export const connection = Layer.unwrap(
  Effect.gen(function* connection() {
    const hosts = yield* Host;

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
      DeploymentProvider()
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

    const slice = yield* ObjectStore.Slice(node.home);

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

    const documents = yield* fs.readFileString(
      yield* Config.String("RAT_KING_DOCUMENTS")
    );

    const version = yield* Config.String("RAT_KING_VERSION");
    const commit = yield* Config.String("RAT_KING_COMMIT");
    const serviceDid = yield* Config.String("RAT_KING_SERVICE_DID");

    const prepared = yield* prepareDeployment(
      path.resolve(import.meta.dirname, "../../apps/mailbox/src/worker.ts"),
      bindings,
      {
        commit,
        vars: {
          DID_DOCUMENTS: documents,
          SERVICE_DID: serviceDid,
        },
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
        cells.unit.sha256
      ).pipe(
        Output.map(([workerUrl, internalUrl, directory]) => ({
          ...prepared,
          binary: `${node.home}/.local/share/rat-king/bin/celld`,
          directory: `${directory}/mailbox-deployment`,
          environmentFile: `${directory}/celld.env`,
          internalUrl,
          workerUrl,
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
