import { DurableObject } from "alchemy/Cloudflare";
import type { DurableObjectLike, WorkerProps } from "alchemy/Cloudflare";
import type { Redacted } from "effect";
import { Schema } from "effect";

import { GeneratedConfiguration } from "../../packages/alchemy-nest/src/deployment-config.ts";
import type { Declaration } from "../../packages/alchemy-nest/src/deployment-config.ts";

export interface PreparedBundle {
  readonly bundle: string;
  readonly configuration: string;
}

export const workerName = "rat-king-mailbox-preview";

export const projectWorker = (
  declaration: typeof Declaration.Type,
  prepared: PreparedBundle,
  identity: Redacted.Redacted
) => {
  const configuration = Schema.decodeSync(
    Schema.fromJsonString(GeneratedConfiguration)
  )(prepared.configuration);

  if (
    configuration.vars.AGENT_MODEL !== "faux" ||
    Object.keys(configuration.vars).some(
      (key) =>
        key.startsWith("MODEL_GATEWAY_") || key.startsWith("CLAUDE_SIDECAR_")
    )
  ) {
    throw new Error("Preview requires faux bindings");
  }

  const objects = Object.fromEntries(
    declaration.durable_objects.bindings.map((binding) => [
      binding.name,
      DurableObject(binding.name, { className: binding.class_name }),
    ])
  );

  const env: Record<string, string | DurableObjectLike | Redacted.Redacted> & {
    AGENT_IDENTITIES_CREDENTIAL: Redacted.Redacted;
  } = {
    ...objects,
    ...configuration.vars,
    AGENT_IDENTITIES_CREDENTIAL: identity,
  };

  return {
    bundle: false,
    compatibility: {
      date: declaration.compatibility_date,
      flags: [...declaration.compatibility_flags],
    },
    env,
    name: workerName,
    script: prepared.bundle,
    workersDev: { enabled: true, previewsEnabled: false },
  } satisfies WorkerProps<
    Record<string, string | DurableObjectLike | Redacted.Redacted>
  >;
};
