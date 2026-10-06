import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { localExec } from "../../packages/alchemy-nest/src/local-exec.ts";
import { assertStarted } from "../../packages/alchemy-nest/src/startup-contract.ts";

const program = Effect.gen(function* restartGate() {
  const address = yield* Schema.decodeUnknownEffect(Schema.String)(
    process.argv[2]
  );

  const unit = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["store", "node"])
  )(process.argv[3]);

  const shell = yield* localExec;

  const nodeActive =
    (yield* shell.exec([
      "systemctl",
      "--user",
      "is-active",
      "rat-king-celld.service",
    ])).code === 0;

  yield* assertStarted(
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
