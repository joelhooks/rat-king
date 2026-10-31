import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import base64, contextlib, io, json, os, pathlib, subprocess, sys, tempfile
script, phase = sys.argv[1], sys.argv[2]
payloads = [base64.b64decode(value) for value in json.loads(sys.argv[3])]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup = root/'data', root/'backup'
    data.mkdir(); backup.mkdir()
    for name in ['celld', 'seaweedfs']:
        (data/name).mkdir(mode=0o700)
    for index, payload in enumerate(payloads):
        target = data/['celld', 'seaweedfs'][index % 2]/('d' + str(index % 3))/('f' + str(index))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        os.utime(target, ns=(10**18 + index, 10**18 + index))
    (data/'seaweedfs/keep').write_bytes(b'unchanged')
    os.utime(data/'seaweedfs/keep', ns=(10**18, 10**18))
    volume = data/'seaweedfs/vol.dat'
    volume.write_bytes(bytes(range(256)) * 800)
    os.utime(volume, ns=(10**18, 10**18))
    (data/'seaweedfs/fresh').write_bytes(b'fresh')
    for other in [data/'celld/state.db', data/'seaweedfs/filer.log']:
        other.write_bytes(bytes(range(256)) * 800)
        os.utime(other, ns=(10**18, 10**18))
    def command(argv, **kwargs):
        if argv[0] == 'findmnt':
            return subprocess.CompletedProcess(argv, 0, str(backup)+'\n', '')
        return subprocess.CompletedProcess(argv, 0, 'ActiveState=inactive\nResult=success\n', '')
    subprocess.run = command
    def run(action, *args, source=script):
        sys.argv = ['backup', action, str(data), str(backup), *args]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exec(source, {})
        return out.getvalue().strip()
    def tree(base):
        return {str(p.relative_to(base)): (p.read_bytes(), p.stat().st_mtime_ns) if p.is_file() else None for p in sorted(base.rglob('*'))}
    def same(staging):
        for name in ['celld', 'seaweedfs']:
            assert tree(staging/name) == tree(data/name), 'Staging differs from source: ' + name
    staging = pathlib.Path(run('stage'))
    if phase == 'cold':
        run('snapshot', str(staging))
        same(staging)
        print('TWOPHASE_PASSED')
        sys.exit(0)
    if phase == 'budget':
        slow = script.replace('SNAPSHOT_BUDGET = 45', 'SNAPSHOT_BUDGET = 1').replace('def copy_file(source, target):', 'def copy_file(source, target):\n    time.sleep(3)')
        assert slow != script
        try:
            run('snapshot', str(staging), source=slow)
            raise AssertionError('Budget did not fire')
        except RuntimeError: pass
        print('TWOPHASE_PASSED')
        sys.exit(0)
    assert run('precopy', str(staging)) == 'BACKUP_PRECOPY_DONE'
    assert (staging/'precopy.json').is_file()
    kept = (staging/'seaweedfs/keep').stat().st_ino
    staged_volume = staging/'seaweedfs/vol.dat'
    volume_inode = staged_volume.stat().st_ino
    old_size = volume.stat().st_size
    def tamper(offset):
        raw = bytearray(staged_volume.read_bytes())
        raw[offset] ^= 0xFF
        staged_volume.write_bytes(bytes(raw))
    if phase in ['tail', 'prefix-mismatch', 'shrunk', 'new-inode', 'recent', 'bad-manifest', 'non-volume-grow']:
        if phase == 'non-volume-grow':
            for other in [data/'celld/state.db', data/'seaweedfs/filer.log']:
                staged = staging/other.relative_to(data)
                raw = bytearray(staged.read_bytes())
                raw[3] ^= 0xFF
                staged.write_bytes(bytes(raw))
                with other.open('ab') as stream:
                    stream.write(b'grown' * 100)
        if phase == 'tail':
            tamper(0)
        if phase == 'prefix-mismatch':
            tamper(old_size - 10)
        if phase == 'recent':
            (staging/'seaweedfs/fresh').write_bytes(b'FRESH')
        if phase == 'bad-manifest':
            (staging/'precopy.json').write_text('[1]')
            tamper(5)
        if phase in ['tail', 'prefix-mismatch']:
            with volume.open('ab') as stream:
                stream.write(b'appended' * 100)
        if phase == 'shrunk':
            tamper(5)
            os.truncate(volume, old_size - 100)
        if phase == 'new-inode':
            tamper(5)
            replacement = data/'seaweedfs/vol.new'
            replacement.write_bytes(bytes(range(255, -1, -1)) * 900)
            os.replace(replacement, volume)
        run('snapshot', str(staging))
        if phase == 'tail':
            assert staged_volume.stat().st_ino == volume_inode
            expected = bytearray(volume.read_bytes())
            expected[0] ^= 0xFF
            assert staged_volume.read_bytes() == bytes(expected), 'Tail path rewrote the prefix'
            assert staged_volume.stat().st_mtime_ns == volume.stat().st_mtime_ns
        else:
            same(staging)
        print('TWOPHASE_PASSED')
        sys.exit(0)
    for index in range(len(payloads)):
        tree_name = ['celld', 'seaweedfs'][index % 2]
        path = data/tree_name/('d' + str(index % 3))/('f' + str(index))
        if index % 3 == 0:
            path.write_bytes(path.read_bytes() + b'changed')
        elif index % 3 == 1:
            path.unlink()
    (data/'celld/added').write_bytes(b'added')
    (data/'seaweedfs/d0').mkdir(exist_ok=True)
    (data/'seaweedfs/d0/f0').unlink(missing_ok=True)
    if phase == 'type-change':
        (data/'seaweedfs/keep').unlink()
        (data/'seaweedfs/keep').mkdir()
        (data/'seaweedfs/keep/inner').write_bytes(b'inner')
        (staging/'seaweedfs/ghost').mkdir()
        (staging/'seaweedfs/ghost/file').write_bytes(b'ghost')
    run('snapshot', str(staging))
    same(staging)
    if phase == 'delta':
        assert (staging/'seaweedfs/keep').stat().st_ino == kept, 'Unchanged file was copied again'
    assert not [p for p in staging.rglob('*') if p.name.endswith('.rk-tmp')]
    print('TWOPHASE_PASSED')
`;

const phases = [
  "delta",
  "type-change",
  "cold",
  "budget",
  "tail",
  "prefix-mismatch",
  "shrunk",
  "new-inode",
  "recent",
  "bad-manifest",
  "non-volume-grow",
] as const;

it.effect.prop(
  "a warm staging copy converges on the changed source after only the delta or appended tail is copied, falls back to a whole-file copy when the tail is unsafe, a cold copy still matches, and the stop budget still fires",
  {
    payloads: Arbitrary.schema(
      Schema.Array(Schema.Uint8Array).check(Schema.isMaxLength(12))
    ),
  },
  ({ payloads }) =>
    Effect.gen(function* twoPhase() {
      const shell = yield* localExec;

      for (const phase of phases) {
        const result = yield* shell.exec([
          "python3",
          "-c",
          fixture,
          backupScript,
          phase,
          JSON.stringify(
            payloads.map((payload) => Buffer.from(payload).toString("base64"))
          ),
        ]);

        expect(result.stdout.trim(), phase).toBe("TWOPHASE_PASSED");
        expect(result.code, phase).toBe(0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);
