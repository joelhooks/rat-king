/* oxlint-disable typescript/promise-function-async -- esbuild is an operator-machine Promise adapter. */
import { Effect } from "effect";
import { build } from "esbuild";
import type { Plugin } from "esbuild";

import {
  bundleDefines,
  DeploymentError,
  wranglerConfiguration,
} from "./deployment-config.ts";
import type { DeploymentBuild, Declaration } from "./deployment-config.ts";

const privateKeyMember = /"d"\s*:/u;

const documentsPlugin = (documents: string | undefined): Plugin[] =>
  documents === undefined
    ? []
    : [
        {
          name: "bundled-documents",
          setup: (builder) => {
            // oxlint-disable-next-line require-unicode-regexp -- esbuild filters use Go regexp syntax, which rejects the u flag.
            builder.onLoad({ filter: /bundled-documents\.ts$/ }, () => ({
              contents: `export const bundledDocuments = ${JSON.stringify(documents)};`,
              loader: "ts",
            }));
          },
        },
      ];

export const prepareDeployment = Effect.fn("Celld.Deployment.build")(
  function* prepareDeployment(
    entrypoint: string,
    declaration: typeof Declaration.Type,
    input: Omit<DeploymentBuild, "main">
  ) {
    if (
      input.documents !== undefined &&
      privateKeyMember.test(input.documents)
    ) {
      return yield* new DeploymentError({
        reason: "Bundled documents must be public-only",
      });
    }

    const config = yield* wranglerConfiguration(declaration, {
      ...input,
      main: "worker.mjs",
    });

    const output = yield* Effect.tryPromise({
      catch: () =>
        new DeploymentError({ reason: "Operator bundle build failed" }),
      try: () =>
        build({
          bundle: true,
          conditions: ["workerd", "worker", "browser"],
          define: bundleDefines(input),
          entryPoints: [entrypoint],
          external: ["cloudflare:workers", "node:*"],
          format: "esm",
          outfile: "worker.mjs",
          platform: "browser",
          plugins: documentsPlugin(input.documents),
          target: "es2022",
          write: false,
        }),
    });

    const bundle = output.outputFiles?.find((file) =>
      file.path.endsWith("worker.mjs")
    );

    if (bundle === undefined) {
      return yield* new DeploymentError({
        reason: "Build produced no Worker module",
      });
    }

    return {
      bundle: bundle.text,
      commit: input.commit,
      configuration: JSON.stringify(config),
      version: input.version,
    };
  }
);
