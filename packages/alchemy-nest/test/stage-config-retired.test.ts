import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Schema,
} from "effect";
import { expect } from "vitest";

import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import type { JsonDocument } from "../../../stacks/nest/stage-config.ts";
import {
  FleetError,
  loadStageConfig,
  StageConfig,
} from "../../../stacks/nest/stage-config.ts";

const load = (document: JsonDocument) =>
  Effect.gen(function* loadDocument() {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFile({ prefix: "stage-config-" });

    yield* fs.writeFileString(file, JSON.stringify(document));

    const warnings: string[] = [];

    const exit = yield* loadStageConfig.pipe(
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([
            Logger.make(({ logLevel, message }) => {
              if (logLevel === "Warn") {
                warnings.push(String(message));
              }
            }),
          ]),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ RAT_KING_STAGE_CONFIG: file })
          )
        )
      ),
      Effect.exit
    );

    yield* fs.remove(file);

    return { exit, warnings };
  }).pipe(Effect.provide(NodeServices.layer));

const withRetired = (
  config: typeof StageConfig.Type,
  ship: typeof ShipSettings.Type,
  retired: string
) => ({
  ...Schema.encodeSync(StageConfig)({ ...config, ship }),
  ship: {
    ...Schema.encodeSync(ShipSettings)(ship),
    restart: { ...Schema.encodeSync(ShipSettings)(ship).restart, [retired]: 1 },
  },
});

it.effect.prop(
  "a retired key still decodes with a warning naming it; any other unknown key is refused naming it",
  [StageConfig, ShipSettings],
  ([config, ship]) =>
    Effect.gen(function* retiredKeys() {
      const stage = yield* Schema.encodeEffect(StageConfig)(config);

      const fixtures = [
        [
          "ship.restart.minIntervalHours",
          withRetired(config, ship, "minIntervalHours"),
        ],
        ...(["local", "remote"] as const).map(
          (host) =>
            [
              `comms.${host}.sessions`,
              {
                ...stage,
                comms: {
                  ...stage.comms,
                  [host]: {
                    ...(host === "remote"
                      ? (stage.comms.remote ?? {
                          ...stage.comms.local,
                          ssh: "fixture.invalid",
                        })
                      : stage.comms.local),
                    sessions: "/unused",
                  },
                },
              },
            ] as const
        ),
      ] as const;

      for (const [key, fixture] of fixtures) {
        const tolerated = yield* load(fixture);

        expect(Exit.isSuccess(tolerated.exit)).toBe(true);
        expect(tolerated.warnings.join("\n")).toContain(key);
        expect(tolerated.warnings.join("\n")).toContain("remove");
      }

      const typo = yield* load(withRetired(config, ship, "minIntervalHour"));

      expect(Exit.isFailure(typo.exit)).toBe(true);

      if (Exit.isFailure(typo.exit)) {
        expect(Cause.pretty(typo.exit.cause)).toContain("minIntervalHour");
      }
    })
);

it("a FleetError renders its tag and reason in a top-level failure", () => {
  const reason = "Invalid stage configuration: unexpected key minIntervalHour";

  expect(Cause.pretty(Cause.fail(new FleetError({ reason })))).toContain(
    `FleetError: ${reason}`
  );
});
