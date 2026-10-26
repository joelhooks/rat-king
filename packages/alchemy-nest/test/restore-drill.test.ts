import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";

const platformFixture = String.raw`
import runpy,sys
m=runpy.run_path(sys.argv[1],run_name='fixture')
sys.platform=sys.argv[2]
try:
    m['require_linux_isolation']()
except RuntimeError as error:
    assert sys.platform != 'linux'
    assert str(error) == 'Linux systemd isolation required'
else:
    assert sys.platform == 'linux', 'Non-Linux isolation was accepted'
print('PLATFORM_GUARD_PASSED')
`;

it.effect.prop(
  "the real isolation guard accepts Linux and rejects non-Linux platforms before systemd work",
  {
    platform: Arbitrary.schema(
      Schema.Literals(["linux", "darwin", "win32", "freebsd14", "aix"])
    ),
  },
  ({ platform }) =>
    Effect.gen(function* platformGuard() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        platformFixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        platform,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("PLATFORM_GUARD_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

const fixture = String.raw`
import contextlib, hashlib, io, json, pathlib, runpy, sys, tarfile, tempfile
m = runpy.run_path(sys.argv[1], run_name='fixture')
size, fault = int(sys.argv[2]), sys.argv[3]
with tempfile.TemporaryDirectory() as tmp:
    base = pathlib.Path(tmp).resolve()
    share = base / 'share'; share.mkdir()
    names = ['20260101T000000.000000Z-' + 'a'*32, '20260102T000000.000000Z-' + 'b'*32]
    for name in names:
        p = share/name; p.mkdir()
        (p/'mailbox.tar.gz').write_bytes(b'archive')
        (p/'manifest.json').write_text('{}')
    (share/('.mailbox-publish-' + names[-1])).mkdir()
    (share/('20260103T000000.000000Z-' + 'c'*32)).symlink_to(share/names[-1], target_is_directory=True)
    assert m['select_archive'](share).name == names[-1]
    (share/names[-1]/'mailbox.tar.gz').unlink()
    try: m['select_archive'](share)
    except RuntimeError: pass
    else: raise AssertionError('A newer published but incomplete archive was silently skipped')
    outside = base/'outside'; outside.mkdir(); (outside/'keep').write_bytes(b'x'*size)
    foreign = base/'restore-drill-foreign'; foreign.mkdir(); (foreign/'keep').write_bytes(b'foreign')
    owned, identity = m['create_root'](base, 'a'*32)
    (owned/'payload').write_bytes(b'x'*size)
    (owned/'escape').symlink_to(outside, target_is_directory=True)
    if fault == 'marker':
        (owned/'.restore-drill-owner').write_text('b'*32)
    elif fault == 'identity':
        identity = (identity[0], identity[1]+1)
    if fault != 'none':
        try: m['remove_root'](owned, 'a'*32, identity)
        except RuntimeError: pass
        else: raise AssertionError('Teardown accepted foreign ownership')
        assert owned.exists()
        (owned/'.restore-drill-owner').write_text('a'*32)
        identity = (owned.stat().st_dev, owned.stat().st_ino)
    m['remove_root'](owned, 'a'*32, identity)
    assert not owned.exists()
    assert (outside/'keep').read_bytes() == b'x'*size
    assert (foreign/'keep').read_bytes() == b'foreign'
    receipt = m['new_receipt']('a'*32)
    assert not m['passed'](receipt)
    receipt['archiveId'] = names[-1]
    receipt['proofs'] = {key: True for key in m['REQUIRED_PROOFS']}
    receipt['teardown'] = {'rootAbsent': True, 'unitAbsent': True, 'processesAbsent': True}
    assert m['passed'](receipt)
    for key in m['REQUIRED_PROOFS']:
        broken = dict(receipt, proofs={**receipt['proofs'], key: False})
        assert not m['passed'](broken), key
    for key in receipt['teardown']:
        assert not m['passed'](dict(receipt, teardown={**receipt['teardown'], key: False}))
    target = base/'receipts.jsonl'
    m['append_receipt'](target, receipt)
    assert json.loads(target.read_text()) == receipt
    assert target.stat().st_mode & 0o777 == 0o600
    snapshot = share/names[0]
    payload = b'x'*size
    archive_path = snapshot/'mailbox.tar.gz'
    with tarfile.open(archive_path, 'w:gz') as archive:
        for name in ['celld', 'seaweedfs']:
            entry = tarfile.TarInfo(name); entry.type = tarfile.DIRTYPE; archive.addfile(entry)
            entry = tarfile.TarInfo(name+'/payload'); entry.size = len(payload); archive.addfile(entry, io.BytesIO(payload))
    manifest = {'format': 4, 'bytes': {'mailbox.tar.gz': archive_path.stat().st_size},
                'sha256': {'mailbox.tar.gz': hashlib.sha256(archive_path.read_bytes()).hexdigest()},
                'trees': {name: {'files': 1, 'directories': 0, 'bytes': size} for name in ['celld', 'seaweedfs']}}
    (snapshot/'manifest.json').write_text(json.dumps(manifest))
    restored, identity = m['create_root'](base, 'c'*32)
    proof = m['restore_archive'](snapshot, restored)
    assert proof['inventories'] == manifest['trees']
    assert all((restored/name/'payload').read_bytes() == payload for name in manifest['trees'])
    m['remove_root'](restored, 'c'*32, identity)
    # A checksum failure must still append a failed receipt and remove its exact root.
    manifest['sha256']['mailbox.tar.gz'] = '0'*64
    (snapshot/'manifest.json').write_text(json.dumps(manifest))
    m['orchestrate'].__globals__['backup_idle'] = lambda: None
    m['orchestrate'].__globals__['require_linux_isolation'] = lambda: None
    m['orchestrate'].__globals__['live_volume_max'] = lambda: 2048
    for p in [share/names[-1]/'manifest.json']: p.unlink()
    scratch = base/'scratch'; scratch.mkdir()
    inventory = base/'instance.json'
    inventory.write_text(json.dumps({'nodes': {'example': {'dataRoot': '/srv/example-production'}}}))
    before = set(base.iterdir())
    with contextlib.redirect_stdout(io.StringIO()):
        code = m['orchestrate']({'backupRoot': str(share), 'scratchParent': str(scratch), 'inventory': str(inventory)}, target)
    assert code == 1
    failed = json.loads(target.read_text().splitlines()[-1])
    assert 'checksum' in failed['error'], failed
    assert failed['status'] == 'fail' and failed['teardown']['rootAbsent']
    assert failed['teardown']['unitAbsent'] and failed['teardown']['processesAbsent']
    assert set(base.iterdir()) == before and not list(scratch.iterdir())
    # Simulate startup failure after diagnostics exist; the real finally must
    # copy them into the durable receipt before deleting the entire root.
    diagnostics = {'children': [{'name': 'celld', 'argv': ['celld', '--listen', '127.0.0.1:1'],
                                'envNames': ['HOME'], 'stdout': '[redacted]',
                                'stderr': '[diagnostic: connection refused]'}]}
    proof_errors = [{'errorKind': 'Error', 'code': 'HTTP_FAILURE', 'phase': 'primary', 'status': 503, 'step': 'reload', 'lastOk': 'auth-fixture'},
                    {'code': 'ASSERTION_FAILED', 'assertionCode': 'MESSAGE_COUNT_MISMATCH', 'expected': 17, 'actual': 16, 'mailboxIndex': 0, 'phase': 'primary', 'step': 'compare-counts', 'lastOk': 'fetch-events'}]
    proof_progress = {'step': 'restore-auth', 'lastOk': 'restore-auth'}
    def startup_failure(source, owned_root):
        log = owned_root/'tail.log'
        log.write_text(('x'*400 + '\n')*400)
        tail = m['bounded_tail'](log)
        assert len(tail.encode()) <= 65536 and len(tail.splitlines()) <= 200
        (owned_root/'diagnostics.json').write_text(json.dumps(diagnostics))
        (owned_root/'proof-errors.json').write_text(json.dumps(proof_errors))
        (owned_root/'proof-progress.json').write_text(json.dumps(proof_progress))
        raise RuntimeError('Injected startup failure')
    m['orchestrate'].__globals__['restore_archive'] = startup_failure
    with contextlib.redirect_stdout(io.StringIO()):
        assert m['orchestrate']({'backupRoot': str(share), 'scratchParent': str(scratch), 'inventory': str(inventory)}, target) == 1
    retained = json.loads(target.read_text().splitlines()[-1])
    assert retained['diagnostics'] == diagnostics
    assert retained['proofErrors'] == proof_errors
    assert retained['proofProgress'] == proof_progress
    assert retained['teardown']['rootAbsent'] and not list(scratch.iterdir())
    assert target.stat().st_mode & 0o777 == 0o600
print('DRILL_PROPERTIES_PASSED')
`;

it.effect.prop(
  "selection never falls back from a broken publication; teardown removes exactly its owned root; every proof gates the receipt",
  {
    fault: Arbitrary.schema(Schema.Literals(["none", "marker", "identity"])),
    size: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 8192, minimum: 0 }))
    ),
  },
  ({ fault, size }) =>
    Effect.gen(function* drillProperties() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        new URL("../../../stacks/nest/restore-drill.py", import.meta.url)
          .pathname,
        String(size),
        fault,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("DRILL_PROPERTIES_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
