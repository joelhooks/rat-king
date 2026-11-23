import { localState } from "alchemy";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { StateRecovery } from "../../packages/alchemy-nest/src/adoption.ts";
import { RuntimeFilesProvider } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { DeploymentProvider } from "../../packages/alchemy-nest/src/deployment.ts";
import { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import { Host } from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import { SecretSource } from "../../packages/alchemy-nest/src/secret-source.ts";
import { startupLayer } from "../../packages/alchemy-nest/src/startup-contract.ts";
import { stageName, workerIPv4 } from "./config.ts";
import { deploymentReleaseSource } from "./deploy-payloads.ts";
import { connection } from "./nest-connection.ts";
import type { PreparedFleetPayload } from "./prepared-payload.ts";
import { restoreOwnedData } from "./restore.ts";
import type { RestoreRequest } from "./restore.ts";

export { connection } from "./nest-connection.ts";

const startup = (restore?: RestoreRequest) =>
  Layer.unwrap(
    Effect.gen(function* startupPorts() {
      const hosts = yield* Host;
      const stage = yield* stageName;

      const node = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      return startupLayer(
        workerIPv4(stage, node),
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

export const nestProviders = (
  restore?: RestoreRequest,
  payload?: PreparedFleetPayload
) => ({
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
    Layer.provide(SecretSource.layer),
    Layer.provide(startup(restore)),
    Layer.provide(connection),
    Layer.provide(deploymentReleaseSource(payload).pipe(Layer.orDie)),
    Layer.provide(FetchHttpClient.layer)
  ),
  state: localState(),
});
