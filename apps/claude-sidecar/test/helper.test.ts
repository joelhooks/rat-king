/* oxlint-disable typescript/promise-function-async -- Filesystem test adapters. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Zero-spend local credential-helper and filesystem qualification.
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { testDirectory } from "../../../tools/test/temp-directory.ts";

it.live.prop(
  "temp cleanup removes its whole root, is repeatable, and leaves symlink targets alone",
  [Arbitrary.schema(Schema.String)],
  ([content]) =>
    Effect.promise(async () => {
      const owned = await testDirectory("rat-king-cleanup-");
      const neighbor = await testDirectory("rat-king-neighbor-");

      try {
        const nested = path.join(owned.directory, "nested");
        const sentinel = path.join(neighbor.directory, "sentinel");
        await mkdir(nested);
        await writeFile(path.join(nested, "fixture"), content);
        await writeFile(sentinel, content);
        const original = await readFile(sentinel);
        await symlink(
          neighbor.directory,
          path.join(owned.directory, "link"),
          "dir"
        );
        await owned.remove();
        await owned.remove();
        expect(existsSync(owned.directory)).toBe(false);
        expect(await readFile(sentinel)).toEqual(original);
      } finally {
        await owned.remove();
        await neighbor.remove();
      }
    })
);

it.live.prop(
  "temp roots reject path-like prefixes before creating anything",
  [
    Arbitrary.schema(
      Schema.Literals(["", ".", "..", "../escape", "/escape", "a/b", "a\\\\b"])
    ),
  ],
  ([prefix]) =>
    Effect.promise(async () => {
      await expect(testDirectory(prefix)).rejects.toThrow();
    })
);
