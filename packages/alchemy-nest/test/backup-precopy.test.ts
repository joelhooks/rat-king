import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  precopyAlarmSeconds,
  precopyLimit,
} from "../../../stacks/nest/backup-limits.ts";
import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, json, pathlib, signal, sys, tempfile, time
script, budget, timeout = sys.argv[1], int(sys.argv[2]), sys.argv[3] == 'true'
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp).resolve()
    for name in ['celld', 'seaweedfs']:
        (data/name).mkdir()
        (data/name/'content').write_bytes(b'content')
    staging = data / ('.mailbox-backup-' + 'a'*32)
    staging.mkdir()
    alarms = []
    handlers = {}
    signal.signal = lambda kind, callback: handlers.update({kind: callback})
    def alarm(seconds):
        alarms.append(seconds)
        if timeout and seconds: handlers[signal.SIGALRM]()
    signal.alarm = alarm
    began = time.monotonic_ns() // 1000
    sys.argv = ['backup', 'precopy', str(data), str(data/'unused-share'), str(staging), str(budget)]
    with contextlib.redirect_stdout(io.StringIO()):
        try: exec(script, {})
        except RuntimeError as error:
            assert timeout and 'Warm-up copy exceeded its budget' in str(error)
        else: assert not timeout
    assert alarms == ([budget] if timeout else [budget, 0]), alarms
    ready = staging/'precopy-ready.json'
    assert ready.exists() != timeout
    if not timeout:
        assert began <= json.loads(ready.read_text()) <= time.monotonic_ns() // 1000
        for name in ['celld', 'seaweedfs']:
            assert (staging/name/'content').read_bytes() == b'content'
    print('PRECOPY_BUDGET_PASSED')
`;

it.effect.prop(
  "precopy installs the supplied SIGALRM budget, fails loudly on expiry, and records completion only after a successful copy",
  {
    gib: Arbitrary.schema(Schema.Literals([0, 100, 112, 300])),
    timeout: Arbitrary.schema(Schema.Boolean),
  },
  ({ gib, timeout }) =>
    Effect.gen(function* precopyAlarm() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        String(precopyAlarmSeconds(precopyLimit(gib * 1_073_741_824))),
        String(timeout),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("PRECOPY_BUDGET_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
