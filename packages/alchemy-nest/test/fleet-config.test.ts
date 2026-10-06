import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, ConfigProvider, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { configuration } from "../../../stacks/nest/config.ts";
import { nodeUnit, sliceUnit, storeUnit } from "../src/service-units.ts";
import { renderUnit } from "../src/systemd.ts";

const node = {
  dataRoot: "/srv/example",
  home: "/home/example",
  ssh: "example.invalid",
  tailnetIPv4: "203.0.113.10",
};

it.effect.prop(
  "fleet refuses runtime/sidecar/cap overrides and projects its fixed mailbox host contract",
  {
    memory: Arbitrary.schema(Schema.Literals(["4G", "1536M", "5632M"])),
    mode: Arbitrary.schema(Schema.Literals(["faux", "gateway"])),
    sidecar: Arbitrary.schema(Schema.Boolean),
  },
  ({ mode, sidecar, memory }) =>
    Effect.gen(function* fleetContract() {
      const result = yield* configuration(node).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RAT_KING_AGENT_MODEL: mode,
              RAT_KING_CLAUDE_SIDECAR: String(sidecar),
              RAT_KING_SLICE_MEMORY_MAX: memory,
              RAT_KING_STAGE: "fleet",
            })
          )
        ),
        Effect.exit
      );

      const permitted = mode === "faux" && !sidecar && memory === "4G";
      expect(Exit.isSuccess(result)).toBe(permitted);

      if (!Exit.isSuccess(result)) {
        return;
      }

      const config = result.value;
      expect(config.mailboxOnly).toBe(true);
      expect(config.hostedDid).toBe("");
      expect(config.remoteAgent).toBe("");
      expect(config.secretName).toBe("");
      expect(config.workerUrl).toBe("http://203.0.113.10:18787");

      const slice = renderUnit(
        sliceUnit(node.home, config.memoryMax, config.cpuQuota)
      );

      expect(slice).toContain("MemoryMax=4G");
      expect(slice).toContain("CPUQuota=200%");

      const restartGate = {
        address: node.tailnetIPv4,
        path: "/opt/example/restart-gate.mjs",
      };

      const store = renderUnit(
        storeUnit({
          binary: "/opt/example/weed",
          config: "/opt/example/s3.json",
          data: "/srv/example/seaweedfs",
          home: node.home,
          restartGate,
          restartOn: [],
        })
      );

      const cells = renderUnit(
        nodeUnit({
          binary: "/opt/example/celld",
          data: "/srv/example/celld",
          environment: "/opt/example/celld.env",
          host: node,
          restartGate,
          restartOn: [],
        })
      );

      for (const unit of [store, cells]) {
        expect(unit).toContain("ExecStartPost=/usr/local/bin/node");
        expect(unit).toContain("Restart=on-failure");
        expect(unit).toContain("WantedBy=default.target");
      }
    }).pipe(Effect.provide(NodeServices.layer))
);
