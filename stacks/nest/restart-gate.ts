import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { localExec } from "../../packages/alchemy-nest/src/local-exec.ts";
import { assertStarted } from "../../packages/alchemy-nest/src/startup-contract.ts";
import { waitForStorage } from "../../packages/alchemy-nest/src/storage-readiness.ts";

const program = Effect.gen(function* restartGate() {
  const address = yield* Schema.decodeUnknownEffect(Schema.String)(
    process.argv[2]
  );

  const unit = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["store", "node", "before-node"])
  )(process.argv[3]);

  const shell = yield* localExec;

  if (unit === "before-node") {
    const location = yield* Config.String("CELLD_BUCKET");

    if (!location.startsWith("s3://")) {
      return yield* refuse("Storage bucket is not configured");
    }

    return yield* waitForStorage(shell, {
      bucket: location.slice(5),
      endpoint: yield* Config.String("S3_ENDPOINT"),
      home: yield* Config.String("HOME"),
    });
  }

  const nodeActive =
    (yield* shell.exec([
      "systemctl",
      "--user",
      "is-active",
      "rat-king-celld.service",
    ])).code === 0;

  return yield* assertStarted(
    shell,
    address,
    unit === "node" || nodeActive,
    false,
    unit === "store" ? 120 : 40
  ).pipe(
    Effect.onError(() =>
      shell
        .exec([
          "systemctl",
          "--user",
          "--no-block",
          "stop",
          "rat-king-celld.service",
          "rat-king-seaweedfs.service",
        ])
        .pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logError("RESTART_GATE_STOP_FAILED", error)
          )
        )
    ),
    Effect.tapError((error) => Effect.logError("RESTART_GATE_FAILED", error))
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
