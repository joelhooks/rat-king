import { Effect, FileSystem, Path, Schema } from "effect";

import { AbsolutePath } from "../../packages/alchemy-nest/src/files.ts";
import { buildFleetModules } from "../../packages/alchemy-nest/src/fleet-build.ts";
import { mailboxManifest } from "./prepared-manifest.ts";
import {
  encodePrepared,
  maxPreparedBytes,
  PackageVersion,
} from "./prepared-payload.ts";
import { Sha } from "./ship-config.ts";
import { readCommand } from "./ship-process.ts";
import { FleetError } from "./stage-config.ts";

const Allowed = new Set([
  "CI",
  "COREPACK_HOME",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_VALUE_0",
  "GIT_NO_LAZY_FETCH",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_USERCONFIG",
  "PATH",
  "PNPM_HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

export const hasOnlyBuildEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): boolean =>
  Object.keys(env).every(
    (name) =>
      Allowed.has(name) ||
      (platform === "darwin" && name === "__CF_USER_TEXT_ENCODING")
  );

const inputError = () =>
  new FleetError({
    reason:
      "ship-build requires a clean build environment without credential or socket inputs",
  });

export const assertBuildEnvironment = Effect.fn("ShipBuild.environment")(
  function* assertBuildEnvironment() {
    const uid = process.getuid?.();

    if (
      uid === undefined ||
      uid === 0 ||
      !hasOnlyBuildEnvironment(process.env, process.platform)
    ) {
      return yield* inputError();
    }

    const { HOME, PATH, XDG_RUNTIME_DIR, XDG_CONFIG_HOME, XDG_DATA_HOME } =
      process.env;

    if (
      !Schema.is(AbsolutePath)(HOME) ||
      !Schema.is(AbsolutePath)(XDG_RUNTIME_DIR) ||
      PATH === undefined ||
      PATH === ""
    ) {
      return yield* inputError();
    }

    const fs = yield* FileSystem.FileSystem;

    for (const directory of [HOME, XDG_RUNTIME_DIR]) {
      if (
        (yield* fs.lstat(directory)).type !== "Directory" ||
        (yield* fs.readDirectory(directory)).length !== 0
      ) {
        return yield* inputError();
      }
    }

    for (const directory of [XDG_CONFIG_HOME, XDG_DATA_HOME]) {
      if (directory === undefined) {
        continue;
      }

      if (
        !Schema.is(AbsolutePath)(directory) ||
        (yield* fs.exists(directory))
      ) {
        return yield* inputError();
      }
    }

    return {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      HOME,
      PATH,
    };
  }
);

const Arguments = Schema.Tuple([
  Schema.Literal("--sha"),
  Sha,
  Schema.Literal("--output"),
  AbsolutePath,
]);

const Version = Schema.fromJsonString(
  Schema.Struct({ version: PackageVersion })
);

export const shipBuildCommand = Effect.fn("ShipBuild.command")(
  function* shipBuildCommand(args: readonly string[]) {
    const [, commit, , output] = yield* Schema.decodeUnknownEffect(Arguments)(
      args
    ).pipe(
      Effect.mapError(
        () =>
          new FleetError({
            reason: "Usage: ship-build --sha <sha> --output <absolute-file>",
          })
      )
    );

    const env = yield* assertBuildEnvironment();
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../..");

    const git = (gitArgs: readonly string[]) =>
      readCommand(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          `safe.directory=${root}`,
          ...gitArgs,
        ],
        root,
        131_072,
        env
      );

    if (
      (yield* git(["rev-parse", "HEAD"])) !== `${commit}\n` ||
      (yield* git(["status", "--porcelain", "--untracked-files=normal"])) !== ""
    ) {
      return yield* new FleetError({
        reason: "Builder checkout is not clean at the requested SHA",
      });
    }

    const { version } = yield* Schema.decodeEffect(Version)(
      yield* git(["show", `${commit}:package.json`])
    ).pipe(
      Effect.mapError(
        () => new FleetError({ reason: "Committed package version refused" })
      )
    );

    const payloads = yield* buildFleetModules(root, {
      commit,
      version,
    });

    const bytes = encodePrepared({
      ...payloads,
      commit,
      manifest: mailboxManifest,
      version,
    });

    if (bytes.length > maxPreparedBytes) {
      return yield* new FleetError({
        reason: "Fleet bundle exceeds byte limit",
      });
    }

    const fs = yield* FileSystem.FileSystem;

    return yield* Effect.scoped(
      Effect.gen(function* publishBundle() {
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: path.dirname(output),
          prefix: ".bundle-",
        });

        const temporary = path.join(directory, "payload");
        yield* fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        yield* fs.rename(temporary, output);
      })
    );
  }
);
