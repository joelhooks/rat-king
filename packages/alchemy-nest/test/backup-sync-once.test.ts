import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import base64, contextlib, io, json, os, pathlib, stat, subprocess, sys, tempfile
script = sys.argv[1]
payloads = [base64.b64decode(value) for value in json.loads(sys.argv[2])]
events = []
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
    def command(argv, **kwargs):
        if argv[0] == 'findmnt':
            return subprocess.CompletedProcess(argv, 0, str(backup)+'\n', '')
        return subprocess.CompletedProcess(argv, 0, 'ActiveState=inactive\nResult=success\n', '')
    subprocess.run = command
    real_fsync = os.fsync
    def fsync(fd):
        events.append('dir' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file')
        real_fsync(fd)
    def syncfs(fd):
        events.append('sync')
    os.fsync, os.syncfs, os.sync = fsync, syncfs, lambda: events.append('sync')
    instrumented = script.replace('def copy_file(source, target):', 'def copy_file(source, target):\n    events.append("copy")').replace('def tree_stats(root, key_names=False, live=False):', 'def tree_stats(root, key_names=False, live=False):\n    events.append("stats")')
    def run(action, *args):
        sys.argv = ['backup', action, str(data), str(backup), *args]
        with contextlib.redirect_stdout(io.StringIO()):
            exec(instrumented, {'events': events})
    def tree(base):
        return {str(p.relative_to(base)): p.read_bytes() if p.is_file() else None for p in sorted(base.rglob('*'))}
    out = io.StringIO()
    sys.argv = ['backup', 'stage', str(data), str(backup)]
    with contextlib.redirect_stdout(out):
        exec(script, {})
    staging = pathlib.Path(out.getvalue().strip())
    for action in ['precopy', 'snapshot']:
        events.clear()
        run(action, str(staging))
        if action == 'precopy':
            assert events.count('sync') == 1, events
            assert events.count('file') == 1, events
            assert events.count('dir') == 1, events
            assert 'copy' not in events[events.index('sync'):], events
        else:
            assert events.count('sync') == 0, events
            assert events.count('file') == 2, events
            assert events.count('stats') == 0, events
        for name in ['celld', 'seaweedfs']:
            assert tree(staging/name) == tree(data/name), 'Staging differs from source'
        (data/'celld/added').write_bytes(b'added' + bytes(len(payloads)))
    print('SYNC_ONCE_PASSED')
`;

it.effect.prop(
  "precopy syncs once, stopped snapshots avoid global sync and full-tree verification, and both stage byte-identical trees",
  {
    payloads: Arbitrary.schema(
      Schema.Array(Schema.Uint8Array).check(Schema.isMaxLength(12))
    ),
  },
  ({ payloads }) =>
    Effect.gen(function* syncOnce() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        JSON.stringify(
          payloads.map((payload) => Buffer.from(payload).toString("base64"))
        ),
      ]);

      expect(result.stdout.trim()).toBe("SYNC_ONCE_PASSED");
      expect(result.code).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 } }
);
