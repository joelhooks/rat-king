import { localState } from "alchemy";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { StateRecovery } from "../../packages/alchemy-nest/src/adoption.ts";
import { RuntimeFilesProvider } from "../../packages/alchemy-nest/src/agent-runtime-files.ts";
import { Celld } from "../../packages/alchemy-nest/src/celld.ts";
import { DeploymentProvider } from "../../packages/alchemy-nest/src/deployment.ts";
import { offlineLayer } from "../../packages/alchemy-nest/src/fake-shell.ts";
import { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { ObjectStore } from "../../packages/alchemy-nest/src/object-store.ts";
import { SecretSource } from "../../packages/alchemy-nest/src/secret-source.ts";
import { layer as sshLayer } from "../../packages/alchemy-nest/src/ssh.ts";
import { startupLayer } from "../../packages/alchemy-nest/src/startup-contract.ts";
import { stageName, workerIPv4 } from "./config.ts";
import { deploymentReleaseSource } from "./deploy-payloads.ts";
import type { PreparedFleetPayload } from "./prepared-payload.ts";
import { restoreOwnedData } from "./restore.ts";
import type { RestoreRequest } from "./restore.ts";
import { guardedShell } from "./ship-restart.ts";

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
