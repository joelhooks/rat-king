#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { AgentName } from "@rat-king/ratking-client/name";
import { Layer, Schema } from "effect";

import { server } from "../src/main.ts";

const args = process.argv.slice(2);

const [, name] = args;

if (args.length !== 2 || args[0] !== "--as" || !Schema.is(AgentName)(name)) {
  process.stderr.write(
    `${JSON.stringify({ failed: "Usage", next: "node apps/ratking-mcp/bin/ratking-mcp.ts --as grokbot/<slug>", why: "Exactly one valid --as name is required." })}\n`
  );
  process.exitCode = 2;
} else {
  NodeRuntime.runMain(Layer.launch(server(name)));
}
