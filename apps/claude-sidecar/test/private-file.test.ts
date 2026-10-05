/* oxlint-disable eslint/no-bitwise -- Generated POSIX permissions. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Owned filesystem property fixtures.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  generateBearer,
  isPrivateFile,
  readPrivateFile,
  requireBearer,
  runningUid,
} from "../src/private-file.ts";

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify ignores execFile's process return.
const execute = promisify(execFile);

const State = Schema.Struct({
  mode: Schema.Int.check(Schema.isBetween({ maximum: 0o7777, minimum: 0 })),
  owned: Schema.Boolean,
  parentMode: Schema.Literals([0o700, 0o720, 0o702]),
  pathLink: Schema.Boolean,
  safeMode: Schema.Literals([0o400, 0o600]),
  tokenBytes: Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 0 })),
  type: Schema.Literals(["regular", "symlink", "directory", "fifo"]),
});

it.live.prop(
  "only owned private regular credentials in non-writable no-link paths are accepted",
  [Arbitrary.schema(State)],
  ([sample]) =>
    Effect.promise(async () => {
      const root = await realpath(tmpdir());

      const directory = await mkdtemp(
        path.join(root, "rat-king-private-file-")
      );

      try {
        const parent = path.join(directory, "parent");
        await mkdir(parent, { mode: 0o700 });
        const target = path.join(parent, "credential");
        const token = generateBearer();
        expect(Buffer.byteLength(token)).toBe(64);
        expect(token).toMatch(/^[0-9a-f]{64}$/u);
        await writeFile(target, token, { mode: sample.safeMode });
        expect(await readPrivateFile(target)).toBe(token);

        const metadata = await stat(target);
        metadata.uid = sample.owned ? runningUid() : runningUid() + 1;
        expect(isPrivateFile(metadata)).toBe(sample.owned);
        metadata.mode = (metadata.mode & constants.S_IFMT) | sample.mode;
        expect(isPrivateFile(metadata)).toBe(
          sample.owned && (sample.mode & 0o7177) === 0
        );
        await chmod(target, sample.mode);
        let file = target;

        switch (sample.type) {
          case "symlink": {
            file = path.join(parent, "link");
            await symlink(target, file);

            break;
          }

          case "directory": {
            file = path.join(parent, "directory");
            await mkdir(file, { mode: 0o700 });

            break;
          }

          case "fifo": {
            file = path.join(parent, "fifo");
            await execute("/usr/bin/mkfifo", [file]);

            break;
          }

          case "regular": {
            break;
          }

          default: {
            const exhaustive: never = sample.type;

            throw new Error(String(exhaustive));
          }
        }

        await chmod(parent, sample.parentMode);

        if (sample.pathLink) {
          const link = path.join(directory, "path-link");
          await symlink(parent, link);
          file = path.join(link, path.basename(file));
        }

        const safe =
          sample.type === "regular" &&
          (sample.mode & 0o7177) === 0 &&
          (sample.mode & 0o400) !== 0 &&
          sample.parentMode === 0o700 &&
          !sample.pathLink;

        const result = await readPrivateFile(file).then(
          () => true,
          () => false
        );

        expect(result).toBe(safe);
        const configured = "a".repeat(sample.tokenBytes);

        if (sample.tokenBytes < 32) {
          expect(() => requireBearer(configured)).toThrow();
        } else {
          expect(requireBearer(configured)).toBe(configured);
        }
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }),
  { arbitrary: { runs: 100 }, timeout: 30_000 }
);
