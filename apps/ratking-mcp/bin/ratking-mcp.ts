#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { AgentName } from "@rat-king/ratking-client/name";
import { Effect, Layer, Schema } from "effect";

import { server } from "../src/main.ts";

const args = process.argv.slice(2);

const [, name] = args;

if (args.length !== 2 || args[0] !== "--as" || !Schema.is(AgentName)(name)) {
  process.stderr.write(
    `${JSON.stringify({ failed: "Usage", next: "node apps/ratking-mcp/bin/ratking-mcp.ts --as grokbot/<slug>", why: "Exactly one valid --as name is required." })}\n`
  );
  process.exitCode = 2;
} else {
  NodeRuntime.runMain(
    Layer.launch(server(name)).pipe(
      Effect.tapCause(() =>
        Effect.sync(() => {
          process.stderr.write(
            `${JSON.stringify({
              failed: "Startup",
              next: "Check RATKING_CONFIG, the configured secret store, and installed dependencies, then restart the server.",
              why: "The configured Rat King client or MCP server could not start. No identity was provisioned by this entrypoint.",
            })}\n`
          );
        })
      )
    ),
    { disableErrorReporting: true }
  );
}
