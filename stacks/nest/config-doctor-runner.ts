import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { Identity } from "../../packages/mailbox-client/src/identity.ts";
import { inspectConfig } from "../../packages/ratking-client/src/config-doctor.ts";
import {
  readConfig,
  settingsLayer,
} from "../../packages/ratking-client/src/config.ts";
import { runCommand } from "../../packages/ratking-client/src/process.ts";
import {
  SecretStore,
  secretStoreLayer,
} from "../../packages/ratking-client/src/secrets.ts";

const program = Effect.gen(function* doctor() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { config, home } = yield* readConfig();

  const expand = (value: string) =>
    home !== undefined && value.startsWith("~/")
      ? path.join(home, value.slice(2))
      : value;

  const readable = (reference: string) =>
    fs.access(expand(reference), { readable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    );

  const executable = Effect.fn("Doctor.executable")(
    function* executable(name: string) {
      const directories = (yield* Config.String("PATH")).split(
        path.sep === "\\" ? ";" : ":"
      );

      const candidates = name.includes("/")
        ? [expand(name)]
        : directories.map((directory) => path.join(directory, name));

      for (const candidate of candidates) {
        if (
          yield* runCommand(["/bin/test", "-x", candidate]).pipe(
            Effect.map((result) => result.code === 0),
            Effect.orElseSucceed(() => false)
          )
        ) {
          return true;
        }
      }

      return false;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => false))
  );

  const hostIdentity = Effect.fn("Doctor.hostIdentity")(
    function* hostIdentity(name: string) {
      const store = yield* SecretStore;
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
        Redacted.value(yield* store.lease(name))
      );

      return true;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => false))
  );

  const inspection = inspectConfig<
    SecretStore | ChildProcessSpawner.ChildProcessSpawner
  >(config, { executable, hostIdentity, readable });

  return yield* Effect.provide(
    inspection,
    secretStoreLayer.pipe(Layer.provide(settingsLayer))
  );
}).pipe(
  Effect.orElseSucceed(() => ({
    reasons: ["Pi configuration inspection failed"],
    status: "fail" as const,
  })),
  Effect.flatMap((result) => Console.log(JSON.stringify(result)))
);

const override = process.argv.at(2);

const environment = { ...process.env };

if (override !== undefined && override !== "") {
  environment.RATKING_CONFIG = override;
}

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(environment)
    )
  )
);
