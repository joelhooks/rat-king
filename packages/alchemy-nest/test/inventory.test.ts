import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Schema,
} from "effect";
import { describe, expect } from "vitest";

import { workerIPv4, workerUrl } from "../../../stacks/nest/config.ts";
import { Host, layer } from "../src/host.ts";
import { NodeSchema } from "../src/inventory-schema.ts";
import { nodeUnit, sliceUnit } from "../src/service-units.ts";
import { renderUnit } from "../src/systemd.ts";

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

const unitProps = (host: typeof NodeSchema.Type) => ({
  binary: "/opt/example/celld",
  data: "/srv/example/cells",
  environment: "/opt/example/celld.env",
  host,
  restartOn: [],
});

describe("RatsNest.Host inventory boundary", () => {
  it.prop(
    "pilot uses loopback while proof preserves node address and default unit bytes",
    {
      octets: Arbitrary.schema(
        Schema.Tuple([
          Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
          Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
          Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
          Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
        ])
      ),
    },
    ({ octets }) => {
      const address = octets.join(".");
      const input = { ...node, tailnetIPv4: address };
      const host = Schema.decodeSync(NodeSchema)(input);
      const props = unitProps(host);

      const proof = renderUnit(
        nodeUnit({ ...props, workerIPv4: workerIPv4("proof", host) })
      );

      expect(JSON.stringify(host)).toBe(JSON.stringify(input));
      expect(proof).toBe(renderUnit(nodeUnit(props)));
      expect(proof).toContain(
        `--listen ${address}:18787 --internal-listen 127.0.0.1:18788`
      );
      expect(workerUrl("proof", host)).toBe(`http://${address}:18787`);
      expect(
        renderUnit(
          nodeUnit({ ...props, workerIPv4: workerIPv4("pilot", host) })
        )
      ).toContain("--listen 127.0.0.1:18787 --internal-listen 127.0.0.1:18788");
      expect(workerUrl("pilot", host)).toBe("http://127.0.0.1:18787");
      expect(renderUnit(sliceUnit(node.home))).toBe(
        renderUnit(sliceUnit(node.home, "4G", "300%"))
      );

      const capped = renderUnit(sliceUnit(node.home, "1536M", "150%"));

      expect(capped).toContain("MemoryMax=1536M");
      expect(capped).toContain("CPUQuota=150%");
    }
  );

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
