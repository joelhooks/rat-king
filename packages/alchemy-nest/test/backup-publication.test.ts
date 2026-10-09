import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const publicationFixture = String.raw`
import base64, contextlib, hashlib, io, json, os, pathlib, subprocess, sys, tarfile, tempfile
script, phase, payload = sys.argv[1], sys.argv[2], base64.b64decode(sys.argv[3])
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup = root/'data', root/'backup'
    data.mkdir(); backup.mkdir()
    (data/'celld').mkdir(mode=0o700)
    def command(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, str(backup)+'\n' if argv[0] == 'findmnt' else 'ActiveState=inactive\nResult=success\n', '')
    subprocess.run = command
    def run(action, *args):
        target = data
        if action == 'restore-preflight': target = root/'fresh'
        elif action == 'restore':
            target = root/'explicit'
            (target/'celld').mkdir(parents=True, mode=0o700, exist_ok=True)
        sys.argv = ['backup', action, str(target), str(backup), *args]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try: exec(script, {})
            except SystemExit as stopped:
                if stopped.code: raise
        return out.getvalue().strip()
    def stage():
        path = pathlib.Path(run('stage'))
        with tarfile.open(path/'objects.tar', 'w') as archive:
            value = b'{"format":2}'
            info = tarfile.TarInfo('format.json'); info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
        with tarfile.open(path/'celld.tar', 'w') as archive:
            info = tarfile.TarInfo('celld/state'); info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        return path
    old_stage = stage()
    old = run('publish', str(old_stage), 'invented', 'invented').split()[-1]
    current = stage()
    stale_local = data/('.mailbox-backup-'+'a'*32)
    stale_local.mkdir(); (stale_local/'objects.tar').write_bytes(b'partial')
    # Invented legacy name has the same shape as an interrupted old publisher.
    legacy = backup/('20000102T030405.123456Z-'+'b'*32)
    legacy.mkdir(); (legacy/'objects.tar').write_bytes(b'partial')
    foreign = backup/('20000102T030405.123456Z-'+'c'*32)
    foreign.mkdir(); (foreign/'user-work').write_bytes(b'preserve')
    original_sync, original_open, original_rename = os.fsync, pathlib.Path.open, pathlib.Path.rename
    opened, committed = {}, []
    def tracked_open(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        opened[stream.fileno()] = path
        return stream
    def sync(fd):
        path = opened.get(fd)
        if phase == 'copy' and path and path.parent.name.startswith('.mailbox-publish-') and path.name == 'objects.tar':
            raise TimeoutError('simulated blocked CIFS writeback timeout')
        return original_sync(fd)
    def rename(path, target):
        if path.parent.name.startswith('.mailbox-publish-') and path.name == 'manifest.pending' and phase == 'manifest':
            raise TimeoutError('simulated manifest timeout')
        if path.name.startswith('.mailbox-publish-'):
            manifest = json.loads((path/'manifest.json').read_text())
            for name, digest in manifest['sha256'].items():
                assert hashlib.sha256((path/name).read_bytes()).hexdigest() == digest
            assert not pathlib.Path(target).exists(), 'Publication replaced existing data'
            if phase == 'rename': raise TimeoutError('simulated pre-commit timeout')
            committed.append(pathlib.Path(target))
        return original_rename(path, target)
    pathlib.Path.open, pathlib.Path.rename, os.fsync = tracked_open, rename, sync
    try:
        try: run('publish', str(current), 'invented', 'invented')
        except TimeoutError: pass
        else: raise AssertionError('Injected failure was swallowed')
    finally:
        pathlib.Path.open, pathlib.Path.rename, os.fsync = original_open, original_rename, original_sync
    hidden = [p for p in backup.iterdir() if p.name.startswith('.mailbox-publish-')]
    assert len(hidden) == 1 and not committed
    assert legacy.exists() and stale_local.exists(), 'Failure cleaned previous partials'
    assert run('restore-preflight') == old, 'Failed publish became latest'
    try:
        run('restore', hidden[0].name)
        raise AssertionError('Explicit restore accepted hidden incomplete backup')
    except RuntimeError: pass
    # Also ignore an arbitrary hidden manifest directory, even if its bytes are complete.
    new = run('publish', str(current), 'invented', 'invented').split()[-1]
    assert new != old
    assert run('restore-preflight') == new
    assert not legacy.exists() and not stale_local.exists() and not hidden[0].exists()
    assert (foreign/'user-work').read_bytes() == b'preserve'
    assert (backup/old/'manifest.json').exists(), 'Success deleted a good backup'
    print('ATOMIC_PUBLICATION_AND_PARTIAL_CLEANUP_PASSED')
`;

it.effect.prop(
  "copy, manifest and pre-rename timeouts cannot publish latest or clean partials before a later successful commit",
  {
    payload: Arbitrary.schema(Schema.Uint8Array),
    phase: Arbitrary.schema(Schema.Literals(["copy", "manifest", "rename"])),
  },
  ({ payload, phase }) =>
    Effect.gen(function* atomicPublication() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        publicationFixture,
        backupScript,
        phase,
        Buffer.from(payload).toString("base64"),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(
        "ATOMIC_PUBLICATION_AND_PARTIAL_CLEANUP_PASSED"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
