/* oxlint-disable eslint/no-bitwise -- POSIX file mode validation uses a permission mask. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off globalConsoleInEffect:off -- Host launcher reads a mode-600 token file and emits one machine-readable readiness line.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Config, Effect, Schema } from "effect";

import { gatewayUrl } from "./gateway-url.ts";
import { SidecarFailure } from "./port.ts";
import { serve } from "./server.ts";

const program = Effect.gen(function* launcher() {
  const tokenFile = yield* Config.String("RAT_KING_SIDECAR_TOKEN_FILE");
  const executable = yield* Config.String("RAT_KING_CLAUDE_EXECUTABLE");

  const token = yield* Effect.tryPromise({
    catch: (cause) => new SidecarFailure({ reason: String(cause) }),
    try: async () => {
      const file = await stat(tokenFile);

      if ((file.mode & 0o777) !== 0o600) {
        throw new Error("Token file must have mode 600");
      }

      return await readFile(tokenFile, "utf-8");
    },
  });

  const endpointFile = yield* Config.String(
    "RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE"
  );

  const keyFile = yield* Config.String("RAT_KING_MODEL_GATEWAY_KEY_FILE");

  const gateway = yield* Effect.tryPromise({
    catch: () => new SidecarFailure({ reason: "Invalid model gateway files" }),
    try: async () => {
      const endpoint = await readFile(endpointFile, "utf-8");
      const key = await stat(keyFile);
      const baseUrl = gatewayUrl(endpoint);
      const apiKeyFile = path.resolve(keyFile);

      if (key.mode % 0o1000 !== 0o600 || key.size === 0) {
        throw new Error("Invalid model gateway files");
      }

      return { apiKeyFile, baseUrl };
    },
  });

  const configuredPort = yield* Config.Int("RAT_KING_SIDECAR_PORT").pipe(
    Config.withDefault(0)
  );

  const port = yield* Schema.decodeEffect(
    Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 0 }))
  )(configuredPort);

  const temporaryRoot = yield* Config.String("RAT_KING_SIDECAR_TEMP_DIR").pipe(
    Config.withDefault("/tmp")
  );

  const server = yield* serve(
    token,
    executable,
    { ...gateway, temporaryRoot },
    port
  );

  yield* Effect.sync(() => {
    console.log(JSON.stringify(server));
  });
  yield* Effect.callback<boolean>((resume) => {
    const stop = () => {
      resume(Effect.succeed(true));
    };

    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);

    return Effect.sync(() => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    });
  });
}).pipe(Effect.scoped);

try {
  await Effect.runPromise(program);
} catch {
  process.exitCode = 1;
}
