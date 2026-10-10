import * as Output from "alchemy/Output";
import { Effect } from "effect";

import type { DeploymentProps } from "./deployment.ts";
import { HostDirectory, RemoteFile } from "./providers.ts";

export const stageDeploymentFiles = Effect.fn("Celld.stageDeploymentFiles")(
  function* stageDeploymentFiles(
    home: string,
    prepared: Pick<DeploymentProps, "bundle" | "configuration">,
    mailboxOnly: boolean
  ) {
    const directory = yield* HostDirectory("mailbox-stage-directory", {
      mode: 0o700,
      path: `${home}/.config/rat-king/mailbox-deployment`,
    });

    const worker = yield* RemoteFile("mailbox-stage-worker", {
      content: prepared.bundle,
      mode: 0o600,
      path: Output.interpolate`${directory.path}/worker.mjs`,
    });

    const configuration = yield* RemoteFile("mailbox-stage-configuration", {
      content: prepared.configuration,
      mode: 0o600,
      path: Output.interpolate`${directory.path}/${mailboxOnly ? "wrangler.json" : "wrangler.public.json"}`,
    });

    return [worker.sha256, configuration.sha256] as const;
  }
);
