import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, pathlib, subprocess, sys, tempfile, time
script, age, cross = sys.argv[1], int(sys.argv[2]), sys.argv[3] == 'true'
started = 3000 * 1000000
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp).resolve()
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert argv[2] == 'show' and '--property=ExecMainStartTimestampMonotonic' in argv
        return subprocess.CompletedProcess(argv, 0, str(started)+'\n', '')
    subprocess.run = command
    readings = iter([(started + age*1000000)*1000, (started + (1200 if cross else age)*1000000)*1000])
    time.monotonic_ns = lambda: next(readings)
    sys.argv = ['backup', 'arm', str(data), str(data/'unused-share')]
    expected = 0 <= age < 1200 and not cross
    with contextlib.redirect_stdout(io.StringIO()):
        try: exec(script, {})
        except RuntimeError:
            assert not expected
        else: assert expected
    assert len(calls) == 1, 'Guard contacted storage or stopped celld'
    marker = data/'.mailbox-backup-restart-required'
    assert marker.exists() == (0 <= age < 1200)
    # An absent unit timestamp fails closed before arming.
    if marker.exists(): marker.unlink()
    time.monotonic_ns = lambda: started * 1000
    subprocess.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, '0\n', '')
    try: exec(script, {})
    except RuntimeError: pass
    else: raise AssertionError('Missing unit start allowed a stop')
    assert not marker.exists()
    print('EARLY_STOP_GUARD_PASSED')
`;

it.effect.prop(
  "arming refuses unknown or twenty-minute-old units and rechecks the age after marker fsync",
  {
    age: Arbitrary.schema(
      Schema.Literals([-1, 0, 239, 1199, 1200, 2100, 7200])
    ),
    cross: Arbitrary.schema(Schema.Boolean),
  },
  ({ age, cross }) =>
    Effect.gen(function* earlyStopGuard() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        String(age),
        String(cross),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("EARLY_STOP_GUARD_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
