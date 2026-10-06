// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- CLI subprocess refusal proof uses invented credentials.
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

it.live.prop(
  "launcher logs the failing bearer or key component and exits 1 without credentials",
  [Arbitrary.schema(Schema.Literals(["bearer", "key"]))],
  ([credential]) =>
    Effect.gen(function* cliRefusal() {
      const root = yield* Effect.promise(
        async () => await realpath(new URL("..", import.meta.url))
      );

      const directory = yield* Effect.promise(
        async () => await mkdtemp(path.join(root, ".cli-diagnostics-test-"))
      );

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await rm(directory, { force: true, recursive: true });
        })
      );
      const bundle = path.join(directory, "sidecar.mjs");
      yield* Effect.promise(
        async () =>
          await build({
            banner: {
              js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
            },
            bundle: true,
            entryPoints: [path.join(root, "src/cli.ts")],
            format: "esm",
            outfile: bundle,
            platform: "node",
            target: "es2022",
            tsconfigRaw: { compilerOptions: {} },
          })
      );
      const secret = "invented-launcher-secret-12345678901234567890";
      const bearer = path.join(directory, "bearer");
      const parent = path.join(directory, "config");
      const key = path.join(parent, "key");
      const endpoint = path.join(directory, "endpoint");
      yield* Effect.promise(async () => {
        await writeFile(bearer, secret, {
          mode: credential === "bearer" ? 0o644 : 0o600,
        });
        await mkdir(parent, { mode: credential === "key" ? 0o775 : 0o700 });
        await writeFile(key, secret, { mode: 0o600 });
        await writeFile(endpoint, "http://127.0.0.1:1");
        await chmod(parent, credential === "key" ? 0o775 : 0o700);
      });

      const result = yield* Effect.callback<{
        code: string | number | null | undefined;
        stdout: string;
        stderr: string;
      }>((resume) => {
        execFile(
          process.execPath,
          [bundle],
          {
            env: {
              ...process.env,
              RAT_KING_CLAUDE_EXECUTABLE: "/invented/missing-claude",
              RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE: endpoint,
              RAT_KING_MODEL_GATEWAY_KEY_FILE: key,
              RAT_KING_SIDECAR_TOKEN_FILE: bearer,
            },
            timeout: 10_000,
          },
          (error, stdout, stderr) => {
            resume(Effect.succeed({ code: error?.code, stderr, stdout }));
          }
        );
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("sidecar_credential_refusal");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual({
        check: "mode",
        component: credential === "bearer" ? bearer : parent,
        event: "sidecar_credential_refusal",
      });
      expect(result.stderr).not.toContain(secret);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 4 }, timeout: 20_000 }
);
