/* oxlint-disable typescript/promise-function-async -- Effect's build adapter returns esbuild's Promise without a redundant async wrapper. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

it.effect(
  "production Worker cannot import the client HPKE seal/open graph",
  () =>
    Effect.gen(function* boundary() {
      const result = yield* Effect.promise(() =>
        build({
          bundle: true,
          entryPoints: ["apps/mailbox/src/worker.ts"],
          external: ["cloudflare:workers", "node:*"],
          format: "esm",
          logLevel: "silent",
          metafile: true,
          platform: "browser",
          write: false,
        })
      );

      const inputs = Object.keys(result.metafile?.inputs ?? {});
      expect(inputs.length).toBeGreaterThan(0);
      expect(
        inputs.some(
          (input) =>
            input.includes("@hpke") ||
            input.endsWith("/envelope/src/envelope.ts")
        )
      ).toBe(false);
    })
);
