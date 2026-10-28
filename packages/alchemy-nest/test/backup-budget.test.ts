import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Schema,
} from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { snapshotLimit } from "../../../stacks/nest/backup.ts";
import { configuration } from "../../../stacks/nest/config.ts";
import { sliceUnit } from "../src/service-units.ts";
import { renderUnit } from "../src/systemd.ts";

const node = {
  dataRoot: "/srv/example",
  home: "/home/example",
  ssh: "example.invalid",
  tailnetIPv4: "203.0.113.10",
};

it.effect.prop(
  "the fleet cap renders 14G without changing proof, pilot or other instance defaults",
  { stage: Arbitrary.schema(Schema.Literals(["fleet", "pilot", "proof"])) },
  ({ stage }) =>
    Effect.gen(function* sliceContract() {
      const config = yield* configuration(node).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RAT_KING_REMOTE_AGENT: "example",
              RAT_KING_REMOTE_DID: "did:web:example.invalid",
              RAT_KING_STAGE: stage,
            })
          )
        )
      );

      expect(
        renderUnit(sliceUnit(node.home, config.memoryMax, config.cpuQuota))
      ).toContain(
        `MemoryMax=${{ fleet: "14G", pilot: "1536M", proof: "4G" }[stage]}\n`
      );
      expect(
        renderUnit(
          sliceUnit(node.home, undefined, undefined, { instance: "another" })
        )
      ).toContain("MemoryMax=4G\n");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "snapshot budgets preserve a named Python failure before the JS timeout and fit the restart allowance",
  () =>
    Effect.gen(function* budgetContract() {
      const pythonSeconds = Number(
        /SNAPSHOT_BUDGET = (?<seconds>\d+)/u.exec(backupScript)?.groups?.seconds
      );

      const jsSeconds = Duration.toSeconds(snapshotLimit);
      const fs = yield* FileSystem.FileSystem;
      const alarms = yield* fs.readFileString("stacks/nest/alarm-sources.ts");

      const allowanceMs = Number(
        /now - deploy.started \* 1000 < (?<milliseconds>[\d_]+)/u
          .exec(alarms)
          ?.groups?.milliseconds?.replaceAll("_", "")
      );

      expect(pythonSeconds).toBe(45);
      expect(jsSeconds).toBe(60);
      expect(jsSeconds).toBeGreaterThan(pythonSeconds);
      expect((7 + 15 + pythonSeconds + 21) * 1000).toBeLessThan(allowanceMs);
      expect((7 + 15 + jsSeconds + 21) * 1000).toBeLessThan(allowanceMs);
    }).pipe(Effect.provide(NodeServices.layer))
);
