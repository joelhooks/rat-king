import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  AlarmFacts,
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import { backupScript } from "../../../stacks/nest/backup-script.ts";
import type { StopMemory } from "../../../stacks/nest/stop-memory.ts";
import {
  stopReserveBytes,
  stopWarningBytes,
  stopMemoryWarnings,
} from "../../../stacks/nest/stop-memory.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile, time
script, samples, reserve = sys.argv[1], json.loads(sys.argv[2]), int(sys.argv[3])
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp).resolve()
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert argv[2] == 'show', 'Memory refusal mutated a service'
        if '--property=ExecMainStartTimestampMonotonic' in argv:
            text = '1000000\n'
        else:
            sample = samples[0 if argv[3].endswith('.service') else 1]
            text = 'MemoryCurrent=' + sample[0] + '\nMemoryMax=' + sample[1] + '\nMemoryPeak=0\n'
        return subprocess.CompletedProcess(argv, 0, text, '')
    subprocess.run = command
    time.monotonic_ns = lambda: 2000000000
    sys.argv = ['backup', 'arm', str(data), str(data/'unused')]
    expected = all(current.isdecimal() and maximum.isdecimal() and int(maximum) < 2**63 and int(maximum) - int(current) >= reserve for current, maximum in samples)
    with contextlib.redirect_stdout(io.StringIO()) as output:
        try: exec(script, {})
        except RuntimeError as error:
            assert not expected
            assert 'mailbox left running' in str(error)
        else: assert expected
    assert (data/'.mailbox-backup-restart-required').exists() == expected
    assert 'BACKUP_STOP_MEMORY' in output.getvalue()
    print('STOP_MEMORY_PASSED')
`;

const Delta = Schema.Union([
  Schema.Int.check(
    Schema.isBetween({ maximum: 4_000_000_000, minimum: -4_000_000_000 })
  ),
  Schema.Literals([-1, 0, 1]),
]);

it.effect.prop(
  "arming requires shutdown reserve in both celld and the shared slice without controlling either service",
  [
    Delta,
    Delta,
    Schema.Literals(["finite", "infinity", "missing", "sentinel"]),
  ],
  ([nodeDelta, sliceDelta, kind]) =>
    Effect.gen(function* stopMemoryGuard() {
      const maximum = 8_589_934_592;

      const limit = {
        finite: String(maximum),
        infinity: "infinity",
        missing: "",
        sentinel: "18446744073709551615",
      }[kind];

      const samples = [
        [String(maximum - stopReserveBytes + nodeDelta), limit],
        [String(maximum - stopReserveBytes + sliceDelta), String(maximum)],
      ];

      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        JSON.stringify(samples),
        String(stopReserveBytes),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("STOP_MEMORY_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

it.prop(
  "memory warning reaches the fleet alarm before the stop refusal, including unknown accounting, and clears on recovery",
  [AlarmFacts, Delta, Schema.Literals(["celld", "slice"]), Schema.Boolean],
  ([base, delta, name, missing]) => {
    const maximum = 8_589_934_592;
    const healthy = { current: 0, max: maximum, peak: 0 };

    const memory: typeof StopMemory.Type = {
      celld: healthy,
      slice: healthy,
      [name]: {
        current: missing ? null : maximum - stopWarningBytes + delta,
        max: maximum,
        peak: 0,
      },
    };

    const facts = {
      ...base,
      digest: "ok" as const,
      measurementFailed: false,
      stopMemory: memory,
    };

    const reasons = stopMemoryWarnings(memory);

    const shouldWarn = missing || delta > 0;

    const reading = observeAlarms(emptySources, facts, 0).readings[
      "digest.fail"
    ];

    expect(reasons.length > 0).toBe(shouldWarn);
    expect(reading.status).toBe(shouldWarn ? "firing" : "ok");

    if (reading.status === "firing") {
      expect(reading.severity).toBe("warn");
      expect(reading.evidence).toBe(reasons.join("; "));
    }

    const charge = { current: 0, max: stopWarningBytes, peak: 0 };

    const recovered = observeAlarms(
      emptySources,
      { ...facts, stopMemory: { celld: charge, slice: charge } },
      1
    );

    expect(recovered.readings["digest.fail"].status).toBe("ok");
  }
);
