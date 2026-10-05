import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { describe, expect } from "vitest";

import { Host, layer } from "../src/host.ts";

const node = {
  dataRoot: "/srv/example",
  home: "/home/example",
  ssh: "node-a.example",
  tailnetIPv4: "203.0.113.10",
};

const base = {
  domains: ["network.example"],
  hosts: ["node-a.example"],
  ips: ["203.0.113.10"],
  secretNames: ["example_credential"],
  sites: ["site-a"],
};

const readNode = Effect.gen(function* readNode() {
  return yield* (yield* Host).node("node-a");
});

const configuredLayer = (location: string) =>
  layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ RATS_NEST_INSTANCE: location })
      )
    )
  );

describe("RatsNest.Host inventory boundary", () => {
  it.effect("reads runtime host facts from a private override", () =>
    Effect.gen(function* inventory() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/instance.json`;
      yield* fs.writeFileString(
        path,
        JSON.stringify({ ...base, nodes: { "node-a": node } })
      );
      yield* fs.chmod(path, 0o600);

      const actual = yield* readNode.pipe(
        Effect.provide(configuredLayer(path))
      );

      expect(actual).toEqual(node);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "fails closed on absent nodes, malformed nodes, readable files and missing inventory",
    () =>
      Effect.gen(function* refuse() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const path = `${directory}/instance.json`;
        const query = readNode.pipe(Effect.provide(configuredLayer(path)));
        expect(yield* query.pipe(Effect.isFailure)).toBe(true);
        yield* fs.writeFileString(path, JSON.stringify(base));
        yield* fs.chmod(path, 0o600);
        expect(yield* query.pipe(Effect.isFailure)).toBe(true);
        yield* fs.writeFileString(
          path,
          JSON.stringify({
            ...base,
            nodes: { "node-a": { ...node, dataRoot: 1 } },
          })
        );
        expect(yield* query.pipe(Effect.isFailure)).toBe(true);
        yield* fs.writeFileString(
          path,
          JSON.stringify({ ...base, nodes: { "node-a": node } })
        );
        yield* fs.chmod(path, 0o644);
        expect(yield* query.pipe(Effect.isFailure)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
