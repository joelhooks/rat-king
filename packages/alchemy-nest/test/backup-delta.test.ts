import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import base64, contextlib, io, json, os, pathlib, subprocess, sys, tempfile, time
script, encoded, fault = sys.argv[1:4]
payloads = [base64.b64decode(value) for value in json.loads(encoded)]
events = []
clock = [time.time_ns()]
script = script.replace('    checksum = digest(target, info.st_size)', '    if live and source.name == "race":\n        clock[0] += 3 * 10**9\n        source.write_bytes(b"after!")\n        os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns))\n    checksum = digest(target, info.st_size)')
script = script.replace('def copy_file(source, target):', 'def copy_file(source, target):\n    events.append(("copy", str(source.relative_to(data))))')
script = script.replace('def digest(path, length=None):', 'def digest(path, length=None):\n    events.append(("digest", str(path)))')
script = script.replace('def tree_stats(root, key_names=False, live=False):', 'def tree_stats(root, key_names=False, live=False):\n    raise AssertionError("Stopped full walk")')
script = script.replace('def verify_snapshot(staging, entries, trees):', 'def verify_snapshot(staging, entries, trees):\n    events.append(("verify", "staging"))')
script = script.replace('def snapshot_members(path, trees, entries=None):', 'def snapshot_members(path, trees, entries=None):\n    events.append(("verify", "archive"))')
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup = root/'data', root/'backup'
    data.mkdir(); backup.mkdir()
    for name in ['celld', 'seaweedfs']:
        (data/name).mkdir()
    subprocess.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, 'ActiveState=inactive\nResult=success\n', '')
    os.sync = lambda: None
    os.syncfs = lambda fd: None
    def put(key, value):
        target = data/key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
        os.utime(target, ns=(10**18, 10**18))
    put('celld/race', b'before')
    os.utime(data/'celld/race', ns=(clock[0] - 1500_000_000, clock[0] - 1500_000_000))
    put('celld/keep', b'keep')
    put('celld/replace', b'before')
    put('celld/deleted/child', b'delete')
    (data/'celld/empty').mkdir()
    for index, payload in enumerate(payloads):
        put('seaweedfs/f' + str(index), payload)
    def run(action, *args, source=script):
        sys.argv = ['backup', action, str(data), str(backup), *args]
        out = io.StringIO()
        original_clock = time.time_ns
        try:
            time.time_ns = lambda: clock[0]
            with contextlib.redirect_stdout(out):
                exec(source, {'events': events, 'clock': clock})
        finally:
            time.time_ns = original_clock
        return out.getvalue().strip()
    staging = pathlib.Path(run('stage'))
    run('precopy', str(staging))
    assert json.loads((staging/'precopy.json').read_text())['celld/race'][3], 'Copy duration hid the recent stat race'
    changed = {'celld/replace', 'celld/new', 'celld/race'}
    replacement = data/'celld/replacement'
    replacement.write_bytes(b'after!')
    os.utime(replacement, ns=(10**18, 10**18))
    os.replace(replacement, data/'celld/replace')
    (data/'celld/deleted/child').unlink()
    (data/'celld/deleted').rmdir()
    (data/'celld/empty').rmdir()
    put('celld/new', b'new')
    for index, payload in enumerate(payloads):
        key = 'seaweedfs/f' + str(index)
        if index % 3 == 0:
            put(key, payload + b'changed')
            changed.add(key)
        elif index % 3 == 1:
            (data/key).unlink()
    events.clear()
    run('snapshot', str(staging))
    assert {key for event, key in events if event == 'copy'} == changed, events
    digested = {key for event, key in events if event == 'digest'}
    assert digested == {str(base/key) for base in [data, staging] for key in changed}, events
    assert not any(event == 'verify' for event, key in events), events
    def tree(base):
        return {str(p.relative_to(base)): p.read_bytes() if p.is_file() else None for p in base.rglob('*')}
    for name in ['celld', 'seaweedfs']:
        assert tree(data/name) == tree(staging/name)
    put('celld/keep', b'live source changes after restart')
    if fault == 'staging':
        (staging/'celld/keep').write_bytes(b'KEEp')
    if fault == 'archive':
        script = script.replace('def add_tree(archive, root, name):', 'def add_tree(archive, root, name):\n    if name == "celld":\n        (root / "keep").write_bytes(b"KEEp")')
    events.clear()
    try:
        run('pack', str(staging), source=script)
        assert fault == 'none', 'Mismatch was accepted'
        assert [(event, key) for event, key in events if event == 'verify'] == [('verify', 'staging'), ('verify', 'archive')]
        assert (staging/'archive.json').is_file()
    except RuntimeError as error:
        assert fault != 'none', str(error)
        assert 'mismatch' in str(error), str(error)
        assert not (staging/'archive.json').exists(), 'Unverified archive became publishable'
    print('DELTA_PASSED')
`;

it.effect.prop(
  "stopped snapshots copy and hash exactly changed entries, remove deletions, and verify the entire frozen tree and archive after restart before publication",
  {
    fault: Schema.Literals(["none", "staging", "archive"]),
    payloads: Arbitrary.schema(
      Schema.Array(Schema.Uint8Array).check(Schema.isMaxLength(12))
    ),
  },
  ({ fault, payloads }) =>
    Effect.gen(function* delta() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        JSON.stringify(
          payloads.map((payload) => Buffer.from(payload).toString("base64"))
        ),
        fault,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("DELTA_PASSED");
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } }
);
