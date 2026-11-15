import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupCover } from "../../../stacks/nest/alarm-maintenance.ts";
import {
  armSlack,
  backupStopBudgetMs,
  precopyMaxLimit,
  stopRestartLimit,
} from "../../../stacks/nest/backup-limits.ts";
import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile, time
script, completion, age, cross, cover, reserve = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == 'true', int(sys.argv[5]), int(sys.argv[6])
started = 3000 * 1000000
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp).resolve()
    staging = data / ('.mailbox-backup-' + 'a'*32)
    staging.mkdir()
    ready = staging / 'precopy-ready.json'
    ready.write_text(json.dumps(started + completion*1000000))
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert argv[2] == 'show'
        text = str(started)+'\n' if '--property=ExecMainStartTimestampMonotonic' in argv else 'MemoryCurrent=0\nMemoryMax=8589934592\nMemoryPeak=0\n'
        return subprocess.CompletedProcess(argv, 0, text, '')
    subprocess.run = command
    now = completion + age
    valid = completion >= 0 and 0 <= age < 1200 and now + reserve <= cover
    readings = iter([(started + now*1000000)*1000, (started + ((completion+1200) if cross else now)*1000000)*1000])
    time.monotonic_ns = lambda: next(readings)
    sys.argv = ['backup', 'arm', str(data), str(data/'unused-share'), str(staging)]
    with contextlib.redirect_stdout(io.StringIO()):
        try: exec(script, {})
        except RuntimeError: assert not valid or cross
        else: assert valid and not cross
    assert len(calls) == (4 if valid else 1), 'Guard contacted storage or stopped celld'
    marker = data/'.mailbox-backup-restart-required'
    assert marker.exists() == valid
    for origin in [None, True, 0, started-1, started+1000000, 'invalid']:
        marker.unlink(missing_ok=True)
        if origin is None: ready.unlink(missing_ok=True)
        else: ready.write_text(json.dumps(origin))
        time.monotonic_ns = lambda: started * 1000
        with contextlib.redirect_stdout(io.StringIO()):
            try: exec(script, {})
            except RuntimeError: pass
            else: raise AssertionError('Invalid completion allowed a stop')
        assert not marker.exists()
    ready.write_text(json.dumps(started))
    subprocess.run = lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, '0\n', '')
    try: exec(script, {})
    except RuntimeError: pass
    else: raise AssertionError('Missing unit start allowed a stop')
    print('EARLY_STOP_GUARD_PASSED')
`;

it.effect.prop(
  "arming validates precopy completion, refuses stale origins and uncovered stops, and rechecks after marker fsync",
  {
    age: Arbitrary.schema(Schema.Literals([-1, 0, 239, 1199, 1200, 2100])),
    completion: Arbitrary.schema(
      Schema.Literals([-1, 0, 5400, 6599, 6600, 6601])
    ),
    cross: Arbitrary.schema(Schema.Boolean),
  },
  ({ age, completion, cross }) =>
    Effect.gen(function* earlyStopGuard() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        String(completion),
        String(age),
        String(cross),
        String(backupStopBudgetMs / 1000),
        String(Duration.toSeconds(stopRestartLimit)),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("EARLY_STOP_GUARD_PASSED");
      const start = 1_000_000;

      const latest =
        start +
        Duration.toMillis(precopyMaxLimit) +
        Duration.toMillis(armSlack);

      expect(backupCover({ end: null, start })?.end).toBe(
        latest + Duration.toMillis(stopRestartLimit)
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
