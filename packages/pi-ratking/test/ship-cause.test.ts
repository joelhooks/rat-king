import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { execute, shipCommand } from "../../../stacks/nest/ship-command.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";

const Key = Schema.Literals(["failed", "successful"]);

const sha = "a".repeat(40);

it.live.prop(
  "a checkpoint missing a required key fails with a reason naming that key and no input values",
  [StageConfig, ShipSettings, Key],
  ([base, settings, missing]) =>
    Effect.gen(function* missingKey() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectory();
      const checkpoint = `${directory}/ship-checkpoint.json`;

      yield* fs.writeFileString(
        checkpoint,
        JSON.stringify(
          Object.fromEntries([
            ...Key.literals
              .filter((key) => key !== missing)
              .map((key) => [key, sha]),
            ["retryAt", 424_242],
          ])
        )
      );

      const error = yield* shipCommand(
        {
          ...base,
          ship: { ...settings, checkpoint, releases: `${directory}/releases` },
        },
        Effect.succeed("running")
      ).pipe(Effect.flip);

      expect(error.reason).toContain("Ship checkpoint invalid");
      expect(error.reason).toContain(missing);
      expect(error.reason).not.toContain(sha);
      expect(error.reason).not.toContain("424242");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "a missing command reports its fixed step and normalized error without command values",
  () =>
    Effect.gen(function* redacted() {
      const error = yield* execute(
        "/nonexistent/ship-command-secret-path",
        ["--token=hunter2"],
        process.cwd(),
        undefined,
        "candidate checkout"
      ).pipe(Effect.flip);

      expect(error.reason).toBe("candidate checkout process failed (NotFound)");
    }).pipe(Effect.provide(NodeServices.layer))
);
