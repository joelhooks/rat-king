// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Test-owned Node filesystem boundary.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const testDirectory = async (prefix: string) => {
  assert.ok(/^[a-zA-Z0-9-]+$/u.test(prefix));
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, prefix));

  return {
    directory,
    remove: async () => {
      assert.ok(path.dirname(directory) === temporaryRoot);
      await rm(directory, { force: true, recursive: true });
    },
  };
};
