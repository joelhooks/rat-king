import { NodeRuntime, NodeServices, NodeStream } from "@effect/platform-node";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Effect, Schema, Stream } from "effect";

import { awaitModule } from "../../packages/alchemy-nest/src/late-module.ts";
import { shipCommand } from "./ship-command.ts";
import { PreparedArguments } from "./ship-prepared-evidence.ts";
import {
  FleetError,
  loadStageConfig,
  preparedStageProvider,
} from "./stage-config.ts";

const lost = () => new FleetError({ reason: "ShipLockSupervisorLost" });

const worker = Effect.gen(function* worker() {
  const orphaned = NodeStream.fromReadable({
    evaluate: () => process.stdin,
    onError: lost,
  }).pipe(Stream.runDrain, Effect.andThen(Effect.fail(lost())));

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
    Effect.raceFirst(orphaned),
    Effect.provide(preparedStageProvider(config))
  );
});

NodeRuntime.runMain(
  worker.pipe(Effect.provide([NodeServices.layer, AuthProvidersLive]))
);
