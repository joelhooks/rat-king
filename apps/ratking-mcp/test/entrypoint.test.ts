// @effect-diagnostics nodeBuiltinImport:off -- Real Node entrypoint failures must never write non-protocol bytes to stdout.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

const Refusal = Schema.Struct({
  failed: Schema.NonEmptyString,
  next: Schema.NonEmptyString,
  why: Schema.NonEmptyString,
});

it.prop(
  "entrypoint refusals are compact JSON on stderr only, for missing configuration and invalid arguments",
  [Schema.Boolean],
  ([firstValidArgs]) => {
    for (const validArgs of [firstValidArgs, !firstValidArgs]) {
      const args = validArgs ? ["--as", "grokbot/example"] : [];

      const result = spawnSync(
        process.execPath,
        [path.resolve("apps/ratking-mcp/bin/ratking-mcp.ts"), ...args],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            RATKING_CONFIG: "/nonexistent/example-ratking-config.json",
          },
          input: "",
          timeout: 10_000,
        }
      );

      expect(result.status).toBe(validArgs ? 1 : 2);
      expect(result.stdout).toBe("");

      const refusal = Schema.decodeUnknownSync(Schema.fromJsonString(Refusal))(
        result.stderr.trim()
      );

      expect(refusal.failed).toBe(validArgs ? "Startup" : "Usage");
    }
  },
  { arbitrary: { runs: 2 } }
);
