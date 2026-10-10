// @effect-diagnostics globalFetch:off -- Composition root supplies the sole outbound transport, guarded inside the model adapter.
import { makeHostedAgent } from "@rat-king/agent-runtime/hosted";
import type { HostedBindings } from "@rat-king/agent-runtime/hosted";

import { agentMailbox, resolveAgentKey } from "./agent-mailbox.ts";
import type { Bindings } from "./bindings.ts";

export const Agent = makeHostedAgent<Bindings & HostedBindings>({
  mailbox: agentMailbox,
  outbound: globalThis.fetch.bind(globalThis),
  resolve: resolveAgentKey,
});

export { Mailbox, AuthTokens, Issuer } from "./worker.ts";

export { default } from "./worker.ts";
