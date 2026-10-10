// @effect-diagnostics asyncFunction:off -- Select the external state directory before importing Alchemy, whose local store captures cwd.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Match,
  Path,
  Schema,
} from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { doneBar } from "./comms.ts";
import { configDoctor } from "./config-doctor.ts";
import { commsCounts, digest } from "./digest.ts";
import { DigestJson, summarize } from "./health.ts";
import { mintHost } from "./mint-host.ts";
import { launchdPlist, shipCommand } from "./ship-command.ts";
import { loadStageConfig, stageProvider } from "./stage-config.ts";

const program = Effect.gen(function* launcher() {
  const stageConfigPath = yield* Config.String("RAT_KING_STAGE_CONFIG");
  const config = yield* loadStageConfig;

  const action = yield* Schema.decodeUnknownEffect(
    Schema.Literals([
      "stop",
      "prepare",
      "plan",
      "deploy",
      "backup",
      "health",
      "ship",
      "ship-plist",
      "digest",
      "doctor",
      "done-bar",
      "mint-host",
      "provision",
      "mailbox",
      "restore",
      "restore-snapshot",
      "listeners",
      "destroy-plan",
      "destroy",
      "teardown-probe",
      "recover-delete",
    ])
  )(process.argv[2]).pipe(Effect.mapError(() => refuse("Unknown nest action")));

  const flags = process.argv.slice(3);

  if (
    flags.length > 0 &&
    action !== "provision" &&
    action !== "mailbox" &&
    (action !== "health" || flags.length !== 2 || flags[0] !== "--previous")
  ) {
    return yield* refuse("Only health accepts --previous <file>");
  }

  if (config.runtime.RAT_KING_OFFLINE_PLAN === true && action !== "plan") {
    return yield* refuse("Offline shell supports plan only");
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previous = flags[1] === undefined ? undefined : path.resolve(flags[1]);
  const resolvedConfigPath = path.resolve(stageConfigPath);
  const directory = path.resolve(config.runtime.RAT_KING_STATE_DIR);
  const root = path.resolve(import.meta.dirname, "../..");

  if (directory === root || directory.startsWith(`${root}/`)) {
    return yield* refuse("State must remain outside the public repository");
  }

  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  const canonical = yield* fs.realPath(directory);

  if (canonical === root || canonical.startsWith(`${root}/`)) {
    return yield* refuse("State resolves inside the public repository");
  }

  process.chdir(canonical);
  process.env.ALCHEMY_TELEMETRY_DISABLED = "1";

  const dispatch = Match.value(action).pipe(
    Match.when("done-bar", () =>
      Effect.gen(function* doneBarCommand() {
        const counts = yield* commsCounts(
          config,
          yield* Clock.currentTimeMillis
        );

        yield* Console.log(
          JSON.stringify({
            local: counts.primary,
            passed: doneBar(counts.primary, counts.secondary),
            remote: counts.secondary,
          })
        );

        if (!doneBar(counts.primary, counts.secondary)) {
          return yield* refuse("Done-bar not met");
        }

        return yield* Effect.void;
      })
    ),
    Match.when("ship", () => shipCommand(config)),
    Match.when("ship-plist", () =>
      Effect.gen(function* printShipPlist() {
        if (config.ship === undefined) {
          return yield* refuse("Ship configuration required");
        }

        return yield* Console.log(launchdPlist(config, resolvedConfigPath));
      })
    ),
    Match.when("doctor", () =>
      configDoctor(config).pipe(
        Effect.tap((facts) =>
          Effect.sync(() => {
            if (facts.status === "fail") {
              process.exitCode = 1;
            }
          })
        ),
        Effect.flatMap((facts) => Console.log(JSON.stringify(facts)))
      )
    ),
    Match.when("mint-host", () => mintHost(config)),
    Match.when(Match.is("provision", "mailbox"), () =>
      Effect.gen(function* mailboxCommand() {
        const mailbox = yield* Effect.tryPromise({
          catch: () => refuse("Mailbox import failed"),
          try: async () => await import("../../apps/mailbox/cli/main.ts"),
        });

        return yield* mailbox.runMailbox(
          action === "provision" ? ["provision", ...flags] : flags
        );
      })
    ),
    Match.orElse((operation) =>
      Effect.gen(function* runtimeCommand() {
        const runtime = yield* Effect.tryPromise({
          catch: () => refuse("Nest runtime import failed"),
          try: async () => await import("./runtime.ts"),
        });

        if (operation === "digest") {
          return yield* Console.log(
            yield* digest(config, runtime.healthDigest)
          );
        }

        if (operation === "health") {
          const facts = yield* runtime.healthDigest(
            previous === undefined
              ? undefined
              : yield* fs.readFileString(previous)
          );

          yield* Console.log(yield* Schema.encodeEffect(DigestJson)(facts));

          return yield* Console.error(summarize(facts));
        }

        return yield* runtime.run(operation);
      })
    )
  );

  return yield* dispatch.pipe(
    Effect.provide(ConfigProvider.layer(stageProvider(config)))
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
