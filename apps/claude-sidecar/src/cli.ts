// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off globalConsoleInEffect:off -- Host launcher reads a mode-600 token file and emits one machine-readable readiness line.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Config, Effect, Schema } from "effect";

import { gatewayUrl } from "./gateway-url.ts";
import { SidecarFailure } from "./port.ts";
import {
  logCredentialRefusal,
  readPrivateFile,
  requireBearer,
} from "./private-file.ts";
import { serve } from "./server.ts";

const program = Effect.gen(function* launcher() {
  const tokenFile = yield* Config.String("RAT_KING_SIDECAR_TOKEN_FILE");
  const executable = yield* Config.String("RAT_KING_CLAUDE_EXECUTABLE");

  const token = yield* Effect.tryPromise({
    catch: (cause) => {
      logCredentialRefusal(cause, tokenFile);

      return new SidecarFailure({ reason: "Bearer credential refused" });
    },
    try: async () => requireBearer(await readPrivateFile(tokenFile), tokenFile),
  });

  const endpointFile = yield* Config.String(
    "RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE"
  );

  const keyFile = yield* Config.String("RAT_KING_MODEL_GATEWAY_KEY_FILE");

  const credentialDirectory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () =>
        new SidecarFailure({ reason: "Cannot create private key snapshot" }),
      try: async () => await mkdtemp(path.join(tmpdir(), "rat-king-key-")),
    }),
    (directory) =>
      Effect.promise(async () => {
        await rm(directory, { force: true, recursive: true });
      })
  );

  const gateway = yield* Effect.tryPromise({
    catch: () => new SidecarFailure({ reason: "Invalid model gateway files" }),
    try: async () => {
      const endpoint = await readFile(endpointFile, "utf-8");

      const key = await readPrivateFile(keyFile).catch((error: unknown) => {
        logCredentialRefusal(error, keyFile);
        throw new SidecarFailure({ reason: "Gateway credential refused" });
      });

      const baseUrl = gatewayUrl(endpoint);
      const apiKeyFile = path.join(credentialDirectory, "key");
      await writeFile(apiKeyFile, key, { flag: "wx", mode: 0o600 });

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
