/* oxlint-disable typescript/promise-function-async -- Loopback-only evidence RPC. */
// @effect-diagnostics asyncFunction:off -- Test Worker adapter.
import type { HostedBindings } from "@rat-king/agent-runtime/hosted";
import { Schema } from "effect";

import type { Bindings } from "../src/bindings.ts";
import type { Agent } from "../src/hosted-worker.ts";
import hosted from "../src/hosted-worker.ts";

export { Agent, Mailbox, AuthTokens, Issuer } from "../src/hosted-worker.ts";

type TestBindings = Omit<Bindings, "AGENT"> &
  HostedBindings & {
    readonly AGENT: DurableObjectNamespace<InstanceType<typeof Agent>>;
  };

export default {
  fetch: async (request: Request, env: TestBindings, ctx: ExecutionContext) => {
    if (new URL(request.url).pathname === "/test/agent-evidence") {
      const [did] = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Array(Schema.String))
      )(env.HOSTED_AGENTS);

      if (did === undefined) {
        return new Response("Invalid hosted config", { status: 500 });
      }

      return Response.json({
        agent: await env.AGENT.getByName(did).evidence(),
        wakes: await env.MAILBOX.getByName(did).wakeEvidence(),
      });
    }

    return await hosted.fetch(request, env, ctx);
  },
};
