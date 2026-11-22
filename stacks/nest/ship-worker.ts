import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { ConfigProvider, Effect, Schema } from "effect";

import { awaitModule } from "../../packages/alchemy-nest/src/late-module.ts";
import { shipCommand } from "./ship-command.ts";
import { PreparedArguments } from "./ship-prepared-evidence.ts";
import { FleetError, loadStageConfig, stageProvider } from "./stage-config.ts";

const worker = Effect.gen(function* worker() {
  const [mode, ...flags] = process.argv.slice(2);
  const config = yield* loadStageConfig;

  if (mode !== "ship-prepared" && (mode !== "ship" || flags.length !== 0)) {
    return yield* new FleetError({ reason: "Ship worker action refused" });
  }

  const prepared =
    mode === "ship-prepared"
      ? yield* Schema.decodeUnknownEffect(PreparedArguments)(flags)
      : undefined;

  const recover = Effect.suspend(() =>
    awaitModule(import("./runtime.ts"), "Nest runtime import failed")
  ).pipe(
    Effect.mapError(
      () => new FleetError({ reason: "Nest runtime import failed" })
    ),
    Effect.flatMap((runtime) => runtime.recoverStorage)
  );

  return yield* shipCommand(config, recover, prepared).pipe(
    Effect.provide(
      ConfigProvider.layerAdd(stageProvider(config), { asPrimary: true })
    )
  );
});

NodeRuntime.runMain(
  worker.pipe(Effect.provide([NodeServices.layer, AuthProvidersLive]))
);
