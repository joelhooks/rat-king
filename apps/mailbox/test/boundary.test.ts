/* oxlint-disable typescript/promise-function-async -- Effect's build adapter returns esbuild's Promise without a redundant async wrapper. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

it.effect("test Worker bundles the envelope HPKE compatibility seam", () =>
  Effect.gen(function* boundary() {
    const result = yield* Effect.promise(() =>
      build({
        bundle: true,
        entryPoints: ["apps/mailbox/test/worker.ts"],
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
      inputs.some((input) => input.endsWith("/envelope/src/hpke-p256.ts"))
    ).toBe(true);
  })
);
