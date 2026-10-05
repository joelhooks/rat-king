import type { HostedBindings } from "@rat-king/agent-runtime/hosted";

import type { Mailbox, AuthTokens } from "./worker.ts";

export interface Bindings {
  readonly MAILBOX: DurableObjectNamespace<Mailbox>;
  readonly AUTH_TOKENS: DurableObjectNamespace<AuthTokens>;
  readonly SERVICE_DID: string;
  readonly DID_DOCUMENTS: string;
  readonly HOSTED_AGENTS?: string;
  readonly AGENT?: {
    readonly getByName: (did: string) => { readonly wake: () => Promise<void> };
  };
  readonly AGENT_IDENTITIES_CREDENTIAL?: HostedBindings["AGENT_IDENTITIES_CREDENTIAL"];
  readonly AGENT_MODEL?: HostedBindings["AGENT_MODEL"];
  readonly MODEL_GATEWAY_BASE_URL?: string;
  readonly MODEL_GATEWAY_CREDENTIAL?: string;
  readonly MODEL_GATEWAY_MODEL?: string;
}

export interface Build {
  readonly version: string;
  readonly commit: string;
  readonly serviceDid: string;
  readonly documents: string;
}

export const bindings = {
  compatibility_date: "2026-10-04",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { class_name: "Mailbox", name: "MAILBOX" },
      { class_name: "AuthTokens", name: "AUTH_TOKENS" },
    ],
  },
  migrations: [{ new_sqlite_classes: ["Mailbox", "AuthTokens"], tag: "v1" }],
  name: "rat-king-mailbox",
};

const hostedObjects = [
  ...bindings.durable_objects.bindings,
  { class_name: "Agent", name: "AGENT" },
];

export const hostedBindings = {
  ...bindings,
  durable_objects: { bindings: hostedObjects },
  migrations: [
    {
      new_sqlite_classes: hostedObjects.map((binding) => binding.class_name),
      tag: "v1",
    },
  ],
};

export interface HostedBuild {
  readonly documents: string;
  readonly hostedDid: string;
  readonly serviceDid: string;
  readonly model: "faux" | "gateway";
  readonly gatewayUrl: string;
  readonly gatewayModel: string;
  readonly sidecar: boolean;
}

export const hostedVars = (input: HostedBuild) => {
  const vars = {
    AGENT_MODEL: input.model,
    DID_DOCUMENTS: input.documents,
    HOSTED_AGENTS: JSON.stringify([input.hostedDid]),
    SERVICE_DID: input.serviceDid,
  };

  if (input.model === "gateway") {
    Object.assign(vars, {
      MODEL_GATEWAY_BASE_URL: input.gatewayUrl,
      MODEL_GATEWAY_MODEL: input.gatewayModel,
    });
  }

  if (input.sidecar) {
    Object.assign(vars, {
      CLAUDE_SIDECAR_BASE_URL: "http://127.0.0.1:18789/v1",
    });
  }

  return vars;
};

export const configuration = (main: string, build: Build) => ({
  ...bindings,
  define: {
    __BUNDLE_COMMIT__: JSON.stringify(build.commit),
    __BUNDLE_VERSION__: JSON.stringify(build.version),
  },
  main,
  vars: { DID_DOCUMENTS: build.documents, SERVICE_DID: build.serviceDid },
});
