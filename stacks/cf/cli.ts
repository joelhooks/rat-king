// @effect-diagnostics asyncFunction:off -- Alchemy captures cwd at import; select external state first.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Path, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { assertFaux } from "./inputs.ts";

const program = Effect.gen(function* launcher() {
  if ((yield* Config.String("ALCHEMY_TELEMETRY_DISABLED")) !== "1") {
    return yield* refuse("Disable Alchemy telemetry");
  }

  yield* Effect.try({
    catch: () => refuse("Preview forbids gateway and sidecar inputs"),
    try: () => {
      assertFaux(process.env);
    },
  });

  const action = yield* Schema.decodeUnknownEffect(
    Schema.Literals([
      "plan",
      "deploy",
      "destroy-plan",
      "destroy",
      "teardown-probe",
    ])
  )(process.argv[2]);

  const approved =
    (yield* Config.String("RAT_KING_CF_DEPLOY_APPROVED").pipe(
      Config.withDefault("false")
    )) === "true";

  const offline = yield* Config.Boolean("RAT_KING_CF_OFFLINE_PLAN").pipe(
    Config.withDefault(true)
  );

  if (
    ((action !== "plan" && action !== "destroy-plan") || !offline) &&
    !approved
  ) {
    return yield* refuse("Explicit Cloudflare approval required");
  }

  if (offline && action !== "plan" && action !== "destroy-plan") {
    return yield* refuse("Offline mode supports planning only");
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));
  const directory = path.resolve(yield* Config.String("RAT_KING_STATE_DIR"));

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
    catch: () => refuse("Preview runtime import failed"),
    try: async () => await import("./runtime.ts"),
  });

  return yield* runtime.run(action, offline);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
