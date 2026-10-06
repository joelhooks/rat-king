// @effect-diagnostics asyncFunction:off -- Select the external state directory before importing Alchemy, whose local store captures cwd.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Path, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";

const program = Effect.gen(function* launcher() {
  if ((yield* Config.String("ALCHEMY_TELEMETRY_DISABLED")) !== "1") {
    return yield* refuse("Disable Alchemy telemetry");
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const action = yield* Schema.decodeUnknownEffect(
    Schema.Literals([
      "stop",
      "prepare",
      "plan",
      "deploy",
      "backup",
      "restore",
      "listeners",
      "destroy-plan",
      "destroy",
      "teardown-probe",
      "recover-delete",
    ])
  )(process.argv[2]);

  if (
    (yield* Config.Boolean("RAT_KING_OFFLINE_PLAN").pipe(
      Config.withDefault(false)
    )) &&
    action !== "plan"
  ) {
    return yield* refuse("Offline shell supports plan only");
  }

  const directory = path.resolve(yield* Config.String("RAT_KING_STATE_DIR"));
  const root = path.resolve(import.meta.dirname, "../..");

  if (directory === root || directory.startsWith(`${root}/`)) {
    return yield* refuse("State must remain outside the public repository");
  }

  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  const canonical = yield* fs.realPath(directory);

  if (canonical === root || canonical.startsWith(`${root}/`)) {
    return yield* refuse("State resolves inside the public repository");
  }

  yield* fs.chmod(canonical, 0o700);
  process.chdir(canonical);

  const runtime = yield* Effect.tryPromise({
    catch: () => refuse("Nest runtime import failed"),
    try: async () => await import("./runtime.ts"),
  });

  return yield* runtime.run(action);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
