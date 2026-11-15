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
import { healthScript } from "../../../stacks/nest/health-script.ts";
import type { StopMemory } from "../../../stacks/nest/stop-memory.ts";
import { stopMemoryWarnings } from "../../../stacks/nest/stop-memory.ts";
import { localExec } from "../src/local-exec.ts";

const fixture = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile, time
backup_script, health_script, samples, mode = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
units = ['rat-king-celld.service', 'rat-king-seaweedfs.service', 'rat-king.slice']
original_read = pathlib.Path.read_text
with tempfile.TemporaryDirectory() as tmp:
    data = pathlib.Path(tmp).resolve()
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert argv[2] == 'show', 'Telemetry controlled a service'
        if '--property=ExecMainStartTimestampMonotonic' in argv:
            text = '1000000\n'
        else:
            assert kwargs['timeout'] == 3
            if mode == 'timeout': raise subprocess.TimeoutExpired(argv, 3)
            sample = samples[units.index(argv[3])]
            group = '/test/' + argv[3] if mode != 'bad-cgroup' else '/../foreign'
            maximum = str(sample['max']) if mode != 'unlimited' else '18446744073709551615'
            text = 'ControlGroup=' + group + '\nMemoryCurrent=' + str(sample['current']) + '\nMemoryMax=' + maximum + '\nMemoryPeak=' + str(sample['peak']) + '\n'
        return subprocess.CompletedProcess(argv, 0, text, '')
    def read(path, *args, **kwargs):
        if str(path).startswith('/sys/fs/cgroup/'):
            assert path.name == 'memory.stat'
            assert str(path.parent.parent) == '/sys/fs/cgroup/test'
            if mode == 'unreadable': raise OSError('unreadable')
            if mode == 'bad-stat': return 'not a memory stat row\n'
            sample = samples[units.index(path.parent.name)]
            return 'anon ' + str(sample['anon']) + '\nfile ' + str(sample['file']) + '\ninactive_file 0\n'
        return original_read(path, *args, **kwargs)
    pathlib.Path.read_text = read
    subprocess.run = command
    time.monotonic_ns = lambda: 2000000000
    sys.argv = ['backup', 'arm', str(data), str(data/'unused')]
    with contextlib.redirect_stdout(io.StringIO()) as output:
        exec(backup_script, {})
    assert (data/'.mailbox-backup-restart-required').exists(), 'Memory sample prevented arming'
    observed = {}
    for line in output.getvalue().splitlines():
        if line.startswith('BACKUP_STOP_MEMORY '):
            _, unit, report = line.split(' ', 2)
            observed[unit] = json.loads(report)
    assert set(observed) == set(units)
    for unit, sample in zip(units, samples):
        expected = dict(sample)
        if mode == 'unlimited': expected['max'] = None
        if mode in ['unreadable', 'bad-stat', 'bad-cgroup']: expected.update(anon=None, file=None)
        if mode == 'timeout': expected = {key: None for key in sample}
        assert observed[unit] == expected, (observed[unit], expected)
    assert len(calls) == 4
    sys.argv = ['health', 'memory']
    with contextlib.redirect_stdout(io.StringIO()) as output:
        exec(health_script, {})
    assert json.loads(output.getvalue()) == {'celld': observed[units[0]], 'seaweedfs': observed[units[1]]}
    assert len(calls) == 6
    print('MEMORY_TELEMETRY_PASSED')
`;

const Bytes = Schema.Int.check(
  Schema.isBetween({ maximum: 20_000_000_000, minimum: 1 })
);

const Sample = Schema.Struct({
  anon: Bytes,
  current: Bytes,
  file: Bytes,
  max: Bytes,
  peak: Bytes,
});

it.effect.prop(
  "backup logs both units and the slice without refusing memory pressure or unreadable accounting, using the same samples as health",
  [
    Schema.Tuple([Sample, Sample, Sample]),
    Schema.Literals([
      "readable",
      "unreadable",
      "unlimited",
      "timeout",
      "bad-stat",
      "bad-cgroup",
    ]),
  ],
  ([samples, mode]) =>
    Effect.gen(function* memoryTelemetry() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        healthScript,
        JSON.stringify(
          samples.map((sample) => ({
            ...sample,
            current: sample.max + sample.current,
          }))
        ),
        mode,
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("MEMORY_TELEMETRY_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);

const Delta = Schema.Union([
  Schema.Int.check(Schema.isBetween({ maximum: 5000, minimum: -5000 })),
  Schema.Literals([-1, 0, 1]),
]);

it.prop(
  "outside a mailbox window, unit anonymous memory warns at 60 percent and clears below it, regardless of charged file cache or slice charge",
  [
    AlarmFacts,
    Delta,
    Schema.Literals(["celld", "seaweedfs"]),
    Schema.Literals(["known", "missing-anon", "missing-cap", "zero-cap"]),
    Bytes,
  ],
  ([base, delta, name, accounting, cache]) => {
    const maximum = 100_000;

    const healthy = {
      anon: 0,
      current: cache,
      file: cache,
      max: maximum,
      peak: cache,
    };

    const memory: typeof StopMemory.Type = {
      celld: healthy,
      seaweedfs: healthy,
      slice: { ...healthy, anon: maximum * 2 },
      [name]: {
        ...healthy,
        anon: accounting === "missing-anon" ? null : maximum * 0.6 + delta,
        max: {
          known: maximum,
          "missing-anon": maximum,
          "missing-cap": null,
          "zero-cap": 0,
        }[accounting],
      },
    };

    const facts = {
      ...base,
      backup: null,
      digest: "ok" as const,
      maintenance: [],
      measurementFailed: false,
      stopMemory: memory,
    };

    const reasons = stopMemoryWarnings(memory);

    const reading = observeAlarms(emptySources, facts, 0).readings[
      "digest.fail"
    ];

    const shouldWarn = accounting !== "known" || delta >= 0;

    expect(reasons.length > 0).toBe(shouldWarn);
    expect(reading.status).toBe(shouldWarn ? "firing" : "ok");

    if (reading.status === "firing") {
      expect(reading.severity).toBe("warn");
      expect(reading.evidence).toBe(reasons.join("; "));
    }

    const recovered = observeAlarms(
      emptySources,
      {
        ...facts,
        stopMemory: {
          ...memory,
          [name]: { ...healthy, anon: maximum * 0.6 - 1 },
        },
      },
      1
    );

    expect(recovered.readings["digest.fail"].status).toBe("ok");
  }
);

it.prop(
  "memory warnings preserve simultaneous digest evidence and leave no-memory measurement gating unchanged",
  [
    AlarmFacts,
    Schema.Literals(["celld", "seaweedfs"]),
    Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 60 })),
    Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  ],
  ([base, name, anon, misses]) => {
    const charge = { anon: 0, current: 100, file: 100, max: 100, peak: 100 };
    const healthy = { celld: charge, seaweedfs: charge };
    const memory = { ...healthy, [name]: { ...charge, anon } };
    const warnings = stopMemoryWarnings(memory);
    const prior = { ...emptySources, measurementMisses: misses };

    for (const digest of ["ok", "fail", null] as const) {
      const facts = { ...base, digest, stopMemory: null };
      const baseline = observeAlarms(prior, facts, 0).readings["digest.fail"];

      const withoutWarning = observeAlarms(
        prior,
        { ...facts, stopMemory: healthy },
        0
      ).readings["digest.fail"];

      const combined = observeAlarms(prior, { ...facts, stopMemory: memory }, 0)
        .readings["digest.fail"];

      const quietStatus =
        facts.measurementFailed || digest === null ? "unknown" : "ok";

      const expectedStatus =
        digest === "fail" || (facts.measurementFailed && misses >= 1)
          ? "firing"
          : quietStatus;

      expect(baseline.status).toBe(expectedStatus);
      expect(withoutWarning).toEqual(baseline);
      expect(combined.status).toBe("firing");

      if (combined.status === "firing") {
        expect(combined.severity).toBe("warn");
        expect(combined.evidence).toBe(
          [
            ...(baseline.status === "firing" ? [baseline.evidence] : []),
            ...warnings,
          ].join("; ")
        );
      }
    }
  }
);
