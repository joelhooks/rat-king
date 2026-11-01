import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, json, os, pathlib, subprocess, sys, tempfile
script, phase, vanish = sys.argv[1], sys.argv[2], sys.argv[3]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup = root/'data', root/'backup'
    data.mkdir(); backup.mkdir()
    for name in ['celld', 'seaweedfs']:
        (data/name).mkdir(mode=0o700)
    (data/'celld'/vanish).write_bytes(b'x')
    (data/'seaweedfs'/'keep').write_bytes(b'y')
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        if argv[0] == 'findmnt':
            return subprocess.CompletedProcess(argv, 0, str(backup)+'\n', '')
        return subprocess.CompletedProcess(argv, 0, 'ActiveState=inactive\nResult=success\n', '')
    subprocess.run = command
    def run(action, *args):
        sys.argv = ['backup', action, str(data), str(backup), *args]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exec(script, {})
        return out.getvalue().strip()
    if phase == 'idle':
        staging = pathlib.Path(run('stage'))
        (staging/'snapshot.json').write_text(json.dumps({'celld': {}, 'seaweedfs': {}}))
        for name in ['celld', 'seaweedfs']:
            (staging/name).mkdir()
        run('pack', str(staging))
        assert any(argv[:2] == ['ionice', '-c3'] for argv in calls), calls
        if hasattr(os, 'getpriority'):
            assert os.getpriority(os.PRIO_PROCESS, 0) == 19
        print('YIELD_PASSED')
        sys.exit(0)
    real = pathlib.Path.lstat
    def vanishing(self, *args, **kwargs):
        if self.name == vanish:
            raise FileNotFoundError(str(self))
        return real(self, *args, **kwargs)
    pathlib.Path.lstat = vanishing
    if phase == 'preflight':
        assert run('preflight').startswith('BACKUP_PREFLIGHT_PASSED')
    else:
        staging = pathlib.Path(run('stage'))
        try: run('snapshot', str(staging))
        except FileNotFoundError: pass
        else: raise AssertionError('Stopped-tree walk tolerated a vanished file')
    print('YIELD_PASSED')
`;

const claims = ["idle", "preflight", "snapshot"] as const;

const names = Schema.String.check(Schema.isPattern(/^[a-z]{1,8}$/u));

it.effect.prop(
  "pack yields at idle priority, the live walk skips a vanished file, and the stopped-tree walk still fails on one",
  {
    claim: Arbitrary.schema(Schema.Literals(claims)),
    vanish: Arbitrary.schema(names),
  },
  ({ claim, vanish }) =>
    Effect.gen(function* yieldClaims() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        claim,
        vanish,
      ]);

      expect(result.stdout.trim()).toBe("YIELD_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
