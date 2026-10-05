// @effect-diagnostics nodeBuiltinImport:off -- Operator bundle entrypoint resolution.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild Promise adapter. */
import { fileURLToPath } from "node:url";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { build } from "esbuild";

import { SidecarFailure } from "./port.ts";

NodeRuntime.runMain(
  Effect.gen(function* bundleSidecar() {
    const output = yield* Config.String("RAT_KING_SIDECAR_OUTPUT");
    yield* Effect.tryPromise({
      catch: () => new SidecarFailure({ reason: "Sidecar bundle failed" }),
      try: () =>
        build({
          banner: {
            js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
          },
          bundle: true,
          entryPoints: [fileURLToPath(new URL("cli.ts", import.meta.url))],
          format: "esm",
          outfile: output,
          platform: "node",
          target: "es2022",
          tsconfigRaw: { compilerOptions: {} },
        }),
    });
  }).pipe(Effect.provide(NodeServices.layer))
);
