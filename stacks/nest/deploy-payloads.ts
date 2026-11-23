import { Config, Effect, FileSystem, Layer, Option, Path } from "effect";

import { bindings, hostedBindings } from "../../apps/mailbox/src/bindings.ts";
import { wranglerConfiguration } from "../../packages/alchemy-nest/src/deployment-config.ts";
import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { awaitModule } from "../../packages/alchemy-nest/src/late-module.ts";
import {
  ReleaseSource,
  sourceLayer,
} from "../../packages/alchemy-nest/src/release.ts";
import { allowManifest } from "./prepared-manifest.ts";
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
    const { commit, manifest, version, worker } = payload;
    yield* allowManifest(manifest);

    if (Object.keys(vars).some((name) => !manifest.variables.includes(name))) {
      return yield* refuse("ManifestChange: needs legacy ship");
    }

    const config = yield* wranglerConfiguration(manifest.declaration, {
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

    const { prepareDeployment } = yield* Effect.suspend(() =>
      awaitModule(
        import("../../packages/alchemy-nest/src/deployment-build.ts"),
        "Worker build module unavailable"
      )
    );

    const { operatorBundle, optionalOperatorBundle } = yield* Effect.suspend(
      () =>
        awaitModule(
          import("../../packages/alchemy-nest/src/operator-build.ts"),
          "Operator bundle module unavailable"
        )
    );

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

  if (!fleet || !mailboxOnly) {
    return Effect.fail(
      refuse("Prepared payloads require a mailbox-only fleet stage")
    );
  }

  return preparedDeployment(payload, vars);
};
