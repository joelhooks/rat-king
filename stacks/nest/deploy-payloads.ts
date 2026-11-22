import { Config, Effect, FileSystem, Layer, Option, Path } from "effect";

import { bindings, hostedBindings } from "../../apps/mailbox/src/bindings.ts";
import { prepareDeployment } from "../../packages/alchemy-nest/src/deployment-build.ts";
import { wranglerConfiguration } from "../../packages/alchemy-nest/src/deployment-config.ts";
import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import {
  operatorBundle,
  optionalOperatorBundle,
} from "../../packages/alchemy-nest/src/operator-build.ts";
import {
  ReleaseSource,
  sourceLayer,
} from "../../packages/alchemy-nest/src/release.ts";
import type { PreparedFleetPayload } from "./prepared-payload.ts";

const noReleaseDownloads = Layer.succeed(ReleaseSource, {
  get: () =>
    Effect.fail(
      refuse("Prepared fleets require the already-pinned host binaries")
    ),
});

export const deploymentReleaseSource = (
  payload: PreparedFleetPayload | undefined
) => (payload === undefined ? sourceLayer : noReleaseDownloads);

export const preparedDeployment = Effect.fn("Nest.preparedDeployment")(
  function* preparedDeployment(
    payload: PreparedFleetPayload,
    vars: Readonly<Record<string, string>>
  ) {
    const { commit, version, worker } = payload;

    const config = yield* wranglerConfiguration(bindings, {
      commit,
      main: "worker.mjs",
      vars,
      version,
    });

    return {
      backup: payload.backup,
      cli: payload.cli,
      deployment: {
        bundle: worker,
        commit,
        configuration: JSON.stringify(config),
        version,
      },
      restart: payload.restart,
    };
  }
);

const legacyDeployment = Effect.fn("Nest.legacyDeployment")(
  function* legacyDeployment(
    fleet: boolean,
    mailboxOnly: boolean,
    vars: Readonly<Record<string, string>>
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commit = yield* Config.String("RAT_KING_COMMIT");
    const version = yield* Config.String("RAT_KING_VERSION");

    const deployment = yield* prepareDeployment(
      path.resolve(
        import.meta.dirname,
        mailboxOnly
          ? "../../apps/mailbox/src/worker.ts"
          : "../../apps/mailbox/src/hosted-worker.ts"
      ),
      mailboxOnly ? bindings : hostedBindings,
      { commit, vars, version }
    );

    const cli = yield* fs.readFileString(
      yield* Config.String("RAT_KING_CLI_OUTPUT")
    );

    const backup = yield* optionalOperatorBundle(
      fleet,
      path.resolve(import.meta.dirname, "backup-runner.ts")
    );

    const restart = fleet
      ? yield* operatorBundle(
          path.resolve(import.meta.dirname, "restart-gate.ts")
        )
      : undefined;

    return { backup: Option.getOrUndefined(backup), cli, deployment, restart };
  }
);

export const deploymentPayloads = (
  fleet: boolean,
  mailboxOnly: boolean,
  vars: Readonly<Record<string, string>>,
  payload: PreparedFleetPayload | undefined
) => {
  if (payload === undefined) {
    return legacyDeployment(fleet, mailboxOnly, vars);
  }

  if (!fleet) {
    return Effect.fail(refuse("Prepared payloads are fleet-only"));
  }

  return preparedDeployment(payload, vars);
};
