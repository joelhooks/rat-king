import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Exit, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { runBackup } from "../../../stacks/nest/backup.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, pathlib, sys, tempfile
script, size = sys.argv[1], int(sys.argv[2])
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data = root / 'data'
    data.mkdir()
    outside = root / 'outside'
    outside.mkdir()
    (outside / 'keep').write_bytes(b'outside')
    stale = [data / ('.mailbox-backup-' + digit * 32) for digit in ['a', 'b']]
    for path in stale:
        path.mkdir()
        (path / 'partial').write_bytes(b'x' * size)
        (path / 'link').symlink_to(outside, target_is_directory=True)
    foreign = data / '.mailbox-backup-x'
    foreign.mkdir()
    (foreign / 'keep').write_bytes(b'foreign')
    link = data / ('.mailbox-backup-' + 'c' * 32)
    link.symlink_to(outside, target_is_directory=True)
    file = data / ('.mailbox-backup-' + 'd' * 32)
    file.write_bytes(b'file')
    def run(action, *args):
        sys.argv = ['backup', action, str(data), str(root / 'unused-share'), *map(str, args)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output): exec(script, {})
        return output.getvalue().strip()
    output = run('prune-staging').splitlines()
    assert sorted(output) == sorted('BACKUP_STALE_STAGING_REMOVED ' + path.name + ' ' + str(size) for path in stale), output
    assert all(not path.exists() for path in stale)
    assert (foreign / 'keep').read_bytes() == b'foreign'
    assert link.is_symlink() and (outside / 'keep').read_bytes() == b'outside'
    assert file.read_bytes() == b'file'
    assert run('prune-staging') == ''
    current = pathlib.Path(run('stage'))
    (current / 'unknown-partial').write_bytes(b'partial')
    assert run('cleanup-staging', current) == 'BACKUP_STAGING_CLEANED'
    assert not current.exists()
    for refused in [foreign, link, file, outside, data / ('../outside/.mailbox-backup-' + 'e' * 32)]:
        try: run('cleanup-staging', refused)
        except RuntimeError: pass
        else: raise AssertionError('Foreign path accepted: ' + str(refused))
    print('STAGING_PASSED')
`;

it.effect.prop(
  "prune deletes only real exact-pattern staging directories and cleanup refuses foreign paths",
  {
    size: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4096, minimum: 0 }))
    ),
  },
  ({ size }) =>
    Effect.gen(function* pruneContract() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        String(size),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("STAGING_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

const published = "20000102T030405.123456Z-0123456789abcdef0123456789abcdef";

it.effect.prop(
  "publication failures skip retention, retention errors preserve backup success, and every staged run cleans its own directory",
  {
    fault: Arbitrary.schema(
      Schema.Literals([
        "arm",
        "snapshot",
        "pack",
        "share-copy",
        "share-manifest",
        "share-verify",
        "cleanup",
        "retention",
        "local-gzip-test",
        "share-gzip-test",
      ])
    ),
  },
  ({ fault }) =>
    Effect.gen(function* failureContract() {
      const fs = yield* FileSystem.FileSystem;

      const dataRoot = yield* fs
        .makeTempDirectoryScoped()
        .pipe(Effect.flatMap((path) => fs.realPath(path)));

      const real = yield* localExec;
      const calls: string[] = [];

      const units = new Map([
        ["rat-king-celld.service", true],
        ["rat-king-seaweedfs.service", true],
      ]);

      let staging = "";

      const shell = {
        exec: Effect.fn("StagingContract.exec")(function* exec(
          argv: readonly string[]
        ) {
          const label =
            argv[0] === "systemctl"
              ? `${argv[2]} ${argv[3]}`
              : (argv[3] ??
                (argv[2]?.startsWith("/mnt/example/") === true
                  ? "share-gzip-test"
                  : "local-gzip-test"));

          calls.push(label);

          if (label === fault) {
            return { code: 1, stdout: "injected failure" };
          }

          if (["prune-staging", "stage", "cleanup-staging"].includes(label)) {
            const result = yield* real.exec(argv);
            expect(result.code, `Real backup ${label} failed`).toBe(0);

            if (label === "stage") {
              staging = result.stdout.trim();
              yield* fs
                .writeFileString(`${staging}/partial`, "partial snapshot")
                .pipe(Effect.orDie);
            }

            return result;
          }

          if (
            argv[0] === "systemctl" &&
            argv[3] !== undefined &&
            (argv[2] === "start" || argv[2] === "stop")
          ) {
            units.set(argv[3], argv[2] === "start");
          }

          const outputs = new Map([
            ["pack", "4096"],
            ["share-open", `.mailbox-publish-${published}`],
            ["share-commit", published],
          ]);

          return { code: 0, stdout: outputs.get(label) ?? "" };
        }),
      };

      const exit = yield* runBackup(shell, {
        backupRoot: "/mnt/example",
        commit: "invented",
        dataRoot,
        home: "/home/example",
        version: "invented",
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(fault !== "retention");
      expect(staging).not.toBe("");
      expect(yield* fs.exists(staging)).toBe(false);
      expect([...units.values()]).toEqual([true, true]);
      expect(calls.indexOf("prune-staging")).toBeLessThan(
        calls.indexOf("preflight")
      );
      expect(calls.indexOf("cleanup-staging")).toBeGreaterThan(
        calls.indexOf(fault)
      );

      if (fault === "retention") {
        expect(calls.indexOf("retention")).toBeGreaterThan(
          calls.indexOf("cleanup")
        );
        expect(calls.indexOf("retention")).toBeGreaterThan(
          calls.indexOf("share-verify")
        );
        expect(calls.indexOf("retention")).toBeGreaterThan(
          calls.indexOf("share-gzip-test")
        );
      } else {
        expect(calls).not.toContain("retention");
      }

      if (fault === "snapshot") {
        expect(
          calls
            .slice(calls.indexOf(fault) + 1)
            .filter((call) => call.startsWith("start "))
        ).toEqual([
          "start rat-king-seaweedfs.service",
          "start rat-king-celld.service",
        ]);
        expect(calls.indexOf("cleanup-staging")).toBeGreaterThan(
          calls.indexOf("start rat-king-celld.service")
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
