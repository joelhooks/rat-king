import { NodeServices, NodeStdio } from "@effect/platform-node";
import { settingsLayer } from "@rat-king/ratking-client/config";
import { directoryLayer } from "@rat-king/ratking-client/directory";
import { issuerLayer } from "@rat-king/ratking-client/issuer";
import { ratKingLayer } from "@rat-king/ratking-client/ratking";
import { secretStoreLayer } from "@rat-king/ratking-client/secrets";
import { Layer, Logger } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import { registration } from "./tools.ts";

export { registration } from "./tools.ts";

export const clientLayer = ratKingLayer.pipe(
  Layer.provideMerge(issuerLayer),
  Layer.provideMerge(secretStoreLayer),
  Layer.provideMerge(directoryLayer),
  Layer.provideMerge(settingsLayer),
  Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
);

export const server = (name: string) =>
  registration(name).pipe(
    Layer.provide(clientLayer),
    Layer.provide(
      McpServer.layerStdio({
        name: "ratking-mcp",
        protocols: [
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
        version: "0.1.0",
      })
    ),
    Layer.provide(NodeStdio.layer),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true))
  );
