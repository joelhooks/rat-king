import { Effect } from "effect";
import { build } from "esbuild";
import type { BuildOptions } from "esbuild";

import { bundleDefines } from "./deployment-config.ts";
import { refuse } from "./files.ts";

const bundle = Effect.fn("Nest.buildFleetModule")(function* bundle(
  options: BuildOptions
) {
  const result = yield* Effect.tryPromise({
    catch: () => refuse("Fleet module build failed"),
    try: build.bind(undefined, {
      ...options,
      bundle: true,
      format: "esm",
      legalComments: "none",
      minifyIdentifiers: true,
      minifyWhitespace: true,
      outfile: "payload.mjs",
      sourcemap: false,
      target: "es2022",
      write: false,
    }),
  });

  const file = result.outputFiles?.[0];

  return file === undefined
    ? yield* refuse("Fleet module build produced no bytes")
    : file.text;
});

const nodeModule = (root: string, entrypoint: string) =>
  bundle({
    absWorkingDir: root,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    entryPoints: [entrypoint],
    platform: "node",
  });

export const buildFleetModules = (
  root: string,
  identity: Parameters<typeof bundleDefines>[0]
) =>
  Effect.all(
    {
      backup: nodeModule(root, "stacks/nest/backup-runner.ts"),
      cli: nodeModule(root, "apps/mailbox/cli/main.ts"),
      restart: nodeModule(root, "stacks/nest/restart-gate.ts"),
      worker: bundle({
        absWorkingDir: root,
        conditions: ["workerd", "worker", "browser"],
        define: bundleDefines(identity),
        entryPoints: ["apps/mailbox/src/worker.ts"],
        external: ["cloudflare:workers", "node:*"],
        platform: "browser",
      }),
    },
    { concurrency: "unbounded" }
  );
