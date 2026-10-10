import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const snapshotFixture = String.raw`
import base64, contextlib, hashlib, io, json, os, pathlib, subprocess, sys, tempfile
script, phase = sys.argv[1], sys.argv[2]
payloads = [base64.b64decode(value) for value in json.loads(sys.argv[3])]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup = root/'data', root/'backup'
    data.mkdir(); backup.mkdir()
    for name in ['celld', 'seaweedfs']:
        (data/name).mkdir(mode=0o700)
    # Generated payloads spread over nested directories in both trees, including empty files.
    for index, payload in enumerate(payloads):
        tree = ['celld', 'seaweedfs'][index % 2]
        target = data/tree/('d' + str(index % 3))/('e' + str(index % 5))/('f' + str(index))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    (data/'seaweedfs/empty-dir').mkdir()
    (data/'seaweedfs/volume.dat').write_bytes(b'invented volume')
    units = {'state': 'inactive'}
    def command(argv, **kwargs):
        if argv[0] == 'findmnt':
            return subprocess.CompletedProcess(argv, 0, str(backup)+'\n', '')
        return subprocess.CompletedProcess(argv, 0, 'ActiveState=' + units['state'] + '\nResult=success\n', '')
    subprocess.run = command
    def run(action, *args):
        sys.argv = ['backup', action, str(data), str(backup), *args]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try: exec(script, {})
            except SystemExit as stopped:
                if stopped.code: raise
        return out.getvalue().strip()
    def tree(base):
        return {str(path.relative_to(base)): (path.read_bytes() if path.is_file() else None) for path in sorted(base.rglob('*'))}
    original = {name: tree(data/name) for name in ['celld', 'seaweedfs']}
    def snapshot():
        staging = pathlib.Path(run('stage'))
        units['state'] = 'active'
        try:
            run('snapshot', str(staging))
            raise AssertionError('Copied while the mailbox was running')
        except RuntimeError: pass
        units['state'] = 'inactive'
        run('snapshot', str(staging))
        return staging
    def publish(staging):
        size = int(run('pack', str(staging)))
        pending = run('share-open')
        run('share-copy', str(staging), pending)
        run('share-manifest', str(staging), pending, 'invented', 'invented')
        name = run('share-commit', pending)
        run('share-verify', str(staging), name)
        return name, size
    # A copy that drops bytes must fail the count/bytes check before any restart.
    if phase == 'short-copy':
        staging = pathlib.Path(run('stage'))
        injected = script.replace('fcntl.ioctl(dst.fileno(), FICLONE, src.fileno())', 'raise OSError("reflink unavailable")').replace('        cache_copy(src, dst, hashed=False)\ndef copy_tree', '        dst.write(src.read() + b"x")\ndef copy_tree')
        assert injected != script
        sys.argv = ['backup', 'snapshot', str(data), str(backup), str(staging)]
        try:
            with contextlib.redirect_stdout(io.StringIO()): exec(injected, {})
            raise AssertionError('Short copy passed verification')
        except RuntimeError: pass
        print('SNAPSHOT_PUBLICATION_RESTORE_PASSED')
        sys.exit(0)
    old_name, _ = publish(snapshot())
    stale_local = data/('.mailbox-backup-'+'a'*32)
    stale_local.mkdir(); (stale_local/'objects.tar').write_bytes(b'partial')
    (stale_local/'celld').mkdir(); (stale_local/'celld/state').write_bytes(b'copy')
    mem_log = data/'.rk-backup-mem-20000102.log'
    mem_log.write_text('invented')
    legacy = backup/('20000102T030405.123456Z-'+'b'*32)
    legacy.mkdir(); (legacy/'objects.tar').write_bytes(b'partial')
    foreign = backup/('20000102T030405.123456Z-'+'c'*32)
    foreign.mkdir(); (foreign/'user-work').write_bytes(b'preserve')
    foreign_local = data/('.mailbox-backup-'+'d'*32)
    foreign_local.mkdir(); (foreign_local/'user-work').write_bytes(b'preserve')
    # Inject a fault at one share step. A fault before commit leaves nothing visible; a readback
    # mismatch after commit fails verification. Either way nothing is cleaned.
    staging = snapshot()
    run('pack', str(staging))
    pending = run('share-open')
    try:
        if phase == 'copy':
            (backup/pending).rename(backup/'moved-away')
        run('share-copy', str(staging), pending)
        if phase == 'manifest':
            (backup/pending/'mailbox.tar.gz').write_bytes(b'tampered')
        if phase == 'commit':
            (backup/pending.split('-publish-')[1]).mkdir()
        run('share-manifest', str(staging), pending, 'invented', 'invented')
        name = run('share-commit', pending)
        run('share-verify', str(staging), name)
        assert phase == 'none', 'Injected share fault was swallowed'
    except RuntimeError:
        assert phase != 'none'
        if phase == 'copy':
            (backup/'moved-away').rename(backup/pending)
        if phase == 'commit':
            (backup/pending.split('-publish-')[1]).rmdir()
        assert stale_local.exists() and mem_log.exists() and legacy.exists(), 'Failure cleaned partials'
        try:
            run('cleanup', str(staging), pending)
            raise AssertionError('Cleanup ran for an unpublished backup')
        except RuntimeError: pass
        staging = snapshot()
        name, _ = publish(staging)
    run('cleanup', str(staging), name)
    survivors = sorted(path.name for path in data.iterdir())
    assert survivors == sorted(['celld', 'seaweedfs', foreign_local.name]), survivors
    assert not legacy.exists() and not mem_log.exists()
    assert not [path for path in backup.iterdir() if path.name.startswith('.mailbox-publish-')]
    assert (foreign/'user-work').read_bytes() == b'preserve'
    assert (backup/old_name/'manifest.json').exists() and (backup/name/'manifest.json').exists(), 'Cleanup deleted a good backup'
    manifest = json.loads((backup/name/'manifest.json').read_text())
    assert manifest['format'] == 4 and set(path.name for path in (backup/name).iterdir()) == {'manifest.json', 'mailbox.tar.gz'}
    # Legacy fresh-target restore refuses to pick an older format while a snapshot is newest.
    try:
        sys.argv = ['backup', 'restore-preflight', str(root/'fresh'), str(backup)]
        with contextlib.redirect_stdout(io.StringIO()): exec(script, {})
        raise AssertionError('Legacy restore skipped a newer snapshot')
    except RuntimeError: pass
    # In-place restore: fetch while serving, swap with both stopped, keep the replaced data aside.
    (data/'celld/written-after-backup').write_bytes(b'newer')
    replaced = {name: tree(data/name) for name in ['celld', 'seaweedfs']}
    local, selected = run('snapshot-fetch').split()
    assert selected == name
    if phase == 'commit':
        # Extraction failure rolls the previous directories back and keeps the partial copy aside.
        injected = script.replace("archive.extract(member, data, filter=secured_member)\n                archive.members.clear()", "raise RuntimeError('injected extraction failure')")
        assert injected != script
        sys.argv = ['backup', 'snapshot-restore', str(data), str(backup), local]
        try:
            with contextlib.redirect_stdout(io.StringIO()): exec(injected, {})
            raise AssertionError('Failed extraction was swallowed')
        except RuntimeError: pass
        assert {name: tree(data/name) for name in ['celld', 'seaweedfs']} == replaced, 'Rollback lost data'
    aside = data/run('snapshot-restore', local).split()[-1]
    assert {name: tree(data/name) for name in ['celld', 'seaweedfs']} == original, 'Restore differs from the snapshot'
    assert {name: tree(aside/name) for name in ['celld', 'seaweedfs']} == replaced, 'Restore lost the replaced data'
    assert not pathlib.Path(local).exists()
    assert (data/'celld').stat().st_mode & 0o777 == 0o700
    print('SNAPSHOT_PUBLICATION_RESTORE_PASSED')
`;

it.effect.prop(
  "a stopped copy matches its source, a share fault never publishes or cleans, and restore swaps in the snapshot while keeping the replaced data",
  {
    payloads: Arbitrary.schema(
      Schema.Array(Schema.Uint8Array).check(Schema.isMaxLength(12))
    ),
    phase: Arbitrary.schema(
      Schema.Literals(["none", "copy", "manifest", "commit", "short-copy"])
    ),
  },
  ({ payloads, phase }) =>
    Effect.gen(function* snapshotRoundtrip() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        snapshotFixture,
        backupScript,
        phase,
        JSON.stringify(
          payloads.map((payload) => Buffer.from(payload).toString("base64"))
        ),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("SNAPSHOT_PUBLICATION_RESTORE_PASSED");
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 25 } }
);
