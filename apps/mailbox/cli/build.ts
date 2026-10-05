// @effect-diagnostics nodeBuiltinImport:off -- Operator build adapter resolves its entrypoint.
import { fileURLToPath } from "node:url";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { build } from "esbuild";

import { CliError } from "./identity.ts";

/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild Promise boundary. */
NodeRuntime.runMain(
  Effect.gen(function* buildCli() {
    const output = yield* Config.String("RAT_KING_CLI_OUTPUT");
    yield* Effect.tryPromise({
      catch: () => new CliError({ reason: "CLI build failed" }),
      try: () =>
        build({
          banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
          },
          bundle: true,
          entryPoints: [
            fileURLToPath(new URL("main.ts", import.meta.url).href),
          ],
          format: "esm",
          outfile: output,
          platform: "node",
          target: "es2022",
        }),
    });
  }).pipe(Effect.provide(NodeServices.layer))
);
