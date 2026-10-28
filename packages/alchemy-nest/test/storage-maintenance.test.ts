import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import type { Interface } from "../src/host-shell.ts";
import { localExec } from "../src/local-exec.ts";
import { nodeUnit } from "../src/service-units.ts";
import { storageMaintenanceScript } from "../src/storage-maintenance-script.ts";
import {
  storageGrowTimer,
  storageGrowUnit,
  storageRetentionTimer,
  storageRetentionUnit,
} from "../src/storage-maintenance.ts";
import { renderUnit, validateUnit } from "../src/systemd.ts";

const fixture = String.raw`import contextlib, datetime, io, json, sys
namespace = {'__name__': 'fixture'}
exec(sys.argv[1], namespace)
payload = json.loads(sys.argv[2])
root = '/topics/.system/log'
today = datetime.datetime(2026, 10, 7, tzinfo=datetime.timezone.utc)
paths = [root + '/' + (today.date() - datetime.timedelta(days=age)).isoformat() for age in payload['ages']]
entries = [{'FullPath': path, 'Mode': 1 << 31} for path in paths]
entries += [{'FullPath': path, 'Mode': 1 << 31} for path in [
    '/buckets/example/2020-01-01', root + '/../../buckets/example',
    root + '/2020-01-01/child', root + '/2020-99-01', root + '/2020-01-01%2f..']]
entries += [{'FullPath': root + '/2020-01-02', 'Mode': 0}]
pages = [entries[:len(entries)//2], entries[len(entries)//2:]]
calls = []
def call(url, method='GET'):
    calls.append((url, method))
    if method == 'DELETE': return {}
    index = sum(method == 'GET' for _, method in calls) - 1
    return {'Path': root, 'Entries': pages[index], 'ShouldDisplayLoadMore': index == 0,
            'LastFileName': '2026-01-01'}
count = namespace['retention'](call, today)
expected = set(path for age, path in zip(payload['ages'], paths) if age > 2)
assert count == len(expected)
assert set(url for url, method in calls if method == 'DELETE') == set(
    'http://127.0.0.1:18888' + path + '?recursive=true' for path in expected)
# No mutations until a complete listing; malformed paths / stalled pages fail closed.
for broken in [dict(Path='/buckets/example', Entries=entries, ShouldDisplayLoadMore=False),
               dict(Path=root, Entries=entries, ShouldDisplayLoadMore=True, LastFileName='')]:
    writes = []
    def bad(url, method='GET'):
        if method != 'GET': writes.append(url)
        return broken
    try:
        namespace['retention'](bad, today)
        raise AssertionError('malformed listing accepted')
    except RuntimeError: pass
    assert not writes
reads = []
def topology(url, method='GET'):
    reads.append((url, method))
    if url.endswith('/vol/status'):
        volumes = [dict(Id=i, Collection='', ReplicaPlacement={}, Ttl=dict(Count=0, Unit=0), ReadOnly=False, Size=100) for i in range(1, max(1, payload['writable']) + 1)]
        return {'Version': '4.48', 'Volumes': {'Max': 2048, 'Free': payload['free'], 'DataCenters': {'dc1': {'rack1': {'node1': volumes}}}}}
    return {'Topology': {'Free': payload['free'], 'Max': 2048, 'Layouts': [
        dict(collection='', replication='000', ttl='', writables=list(range(1, payload['writable'] + 1))),
        dict(collection='example', replication='000', ttl='', writables=[99]),
        dict(collection='', replication='000', ttl='7d', writables=[100])]}}
signal = namespace['diagnostic'](topology)
assert reads == [('http://127.0.0.1:19333/dir/status', 'GET'), ('http://127.0.0.1:19333/vol/status', 'GET')]
assert signal['defaultCollectionWritableVolumes'] == payload['writable']
assert signal['freeVolumeSlots'] == payload['free']
assert signal['alarm'] == (payload['free'] <= 64 or (payload['writable'] == 0 and payload['free'] < 16))
namespace['diagnostic'] = lambda: signal
sys.argv = ['maintenance', 'diagnose']
out, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    result = namespace['main']()
assert result == int(signal['alarm'])
assert json.loads(out.getvalue()) == signal
assert ('storage free-volume slots at or below threshold 64' in err.getvalue()) == (payload['free'] <= 64)
print('RETENTION_BOUNDARY_AND_READ_ONLY_ALARM_PASSED')
`;

it.effect.prop(
  "retention deletes only old log day directories after complete pagination; diagnostic is read-only and alarms at the cliff",
  {
    ages: Arbitrary.schema(
      Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: -10 }))
      )
    ),
    free: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 2048, minimum: 0 }))
    ),
    writable: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }))
    ),
  },
  (payload) =>
    Effect.gen(function* maintenanceProperty() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        storageMaintenanceScript,
        JSON.stringify(payload),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(
        "RETENTION_BOUNDARY_AND_READ_ONLY_ALARM_PASSED"
      );

      const unit = storageRetentionUnit(
        "/home/example",
        "/opt/example/maintenance.py",
        ["ready"]
      );

      const timer = storageRetentionTimer("/home/example", ["ready"]);
      yield* validateUnit(unit);
      yield* validateUnit(timer);
      expect(renderUnit(unit)).toContain("Slice=rat-king.slice");
      expect(renderUnit(unit)).toContain("Restart=on-failure");
      expect(renderUnit(timer)).toContain("Persistent=true");

      const node = nodeUnit({
        binary: "/opt/example/celld",
        data: "/srv/example/celld",
        environment: "/opt/example/celld.env",
        host: {
          dataRoot: "/srv/example",
          home: "/home/example",
          ssh: "example",
          tailnetIPv4: "203.0.113.10",
        },
        restartOn: [],
        storageDiagnostic: "/opt/example/maintenance.py",
      });

      yield* validateUnit(node);
      expect(renderUnit(node)).toContain(
        'ExecStopPost=-/usr/bin/python3 "/opt/example/maintenance.py" diagnose'
      );
      expect(renderUnit(node)).toContain(
        "Environment=CELLD_LTX_RETENTION_SECS=86400"
      );
      expect(renderUnit(node)).toContain(
        "Environment=CELLD_SHUTDOWN_TOTAL_MS=8000"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

const growFixture = String.raw`import contextlib, io, json, sys
namespace = {'__name__': 'fixture'}
exec(sys.argv[1], namespace)
case = json.loads(sys.argv[2])
master = 'http://127.0.0.1:19333'

def build(free, writable, grown):
    def call(url, method='GET'):
        calls.append((url, method))
        if '/vol/grow?count=' in url:
            if case.get('error'): raise RuntimeError('storage request failed: boom')
            if case.get('response') is not None: return case['response']
            count = int(url.split('count=')[1].split('&')[0])
            state['writable'] += count
            state['free'] -= count
            return {'count': count}
        if url.endswith('/vol/status'):
            volumes = [dict(Id=i, Collection='', ReplicaPlacement={}, Ttl=dict(Count=0, Unit=0), ReadOnly=False, Size=100) for i in range(1, max(1, state['writable']) + 1)]
            return {'Version': '4.48', 'Volumes': {'Max': case.get('max', 2048), 'Free': state['free'], 'DataCenters': {'dc1': {'rack1': {'node1': volumes}}}}}
        return {'Topology': {'Free': state['free'], 'Max': case.get('max', 2048), 'Layouts': [
            dict(collection='', replication='000', ttl='', writables=list(range(1, state['writable'] + 1)))]}}
    calls = []
    state = {'free': free, 'writable': writable}
    return call, calls

def run(mode):
    sys.argv = ['maintenance', mode]
    out, err = io.StringIO(), io.StringIO()
    code = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = namespace['main']()
        except Exception as error:
            code = 1
    return code, out.getvalue(), err.getvalue()

call, calls = build(case['free'], case['writable'], False)
namespace['request'] = call
namespace['diagnostic'] = (lambda original: lambda c=call: original(c))(namespace['diagnostic'])
namespace['grow'] = (lambda original: lambda c=call: original(c))(namespace['grow'])
code, out, err = run(case['mode'])
posts = [url for url, method in calls if method == 'POST']
lines = out.splitlines()
print(json.dumps({'code': code, 'err': err, 'first': json.loads(lines[0]) if lines else {}, 'posts': posts}))
`;

const Signal = Schema.Struct({
  defaultCollectionWritableVolumes: Schema.Finite,
  freeVolumeSlots: Schema.Finite,
});

const GrowResult = Schema.Struct({
  code: Schema.Finite,
  err: Schema.String,
  first: Schema.Struct({
    after: Schema.optionalKey(Signal),
    alarm: Schema.optionalKey(Schema.Boolean),
    before: Schema.optionalKey(Signal),
    grew: Schema.optionalKey(Schema.Finite),
  }),
  posts: Schema.Array(Schema.String),
});

const runGrow = (
  shell: Pick<Interface, "exec">,
  input: {
    readonly error?: boolean;
    readonly free: number;
    readonly max?: number;
    readonly mode: string;
    readonly response?: unknown;
    readonly writable: number;
  }
) =>
  shell
    .exec([
      "python3",
      "-c",
      growFixture,
      storageMaintenanceScript,
      JSON.stringify(input),
    ])
    .pipe(
      Effect.flatMap((result) => {
        expect(result.code).toBe(0);

        return Schema.decodeEffect(Schema.fromJsonString(GrowResult))(
          result.stdout
        );
      })
    );

const growUrlFor = (count: number) =>
  `http://127.0.0.1:19333/vol/grow?count=${count}&replication=000`;

const growUrl = growUrlFor(8);

it.effect(
  "grow fires only below 4 writable volumes with more than 64 free slots, never past the floor",
  () =>
    Effect.gen(function* growEdges() {
      const shell = yield* localExec;

      for (const [writable, free, grows] of [
        [3, 65, true],
        [4, 65, false],
        [3, 64, false],
        [3, 2048, true],
        [0, 65, true],
      ] as const) {
        const result = yield* runGrow(shell, { free, mode: "grow", writable });
        const wanted = Math.min(8, free - 64);

        expect(result.posts).toEqual(grows ? [growUrlFor(wanted)] : []);

        const { after, before, grew } = result.first;

        expect(grew).toBe(grows ? wanted : 0);
        expect(result.code).toBe(!grows && free <= 64 ? 1 : 0);
        expect(result.err.includes("shortfall")).toBe(!grows && free <= 64);
        expect(before?.defaultCollectionWritableVolumes).toBe(writable);

        if (grows) {
          expect(after?.defaultCollectionWritableVolumes).toBe(
            writable + wanted
          );
          expect(after?.freeVolumeSlots).toBe(free - wanted);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "grow fails on a request error or a response that is not a positive count",
  () =>
    Effect.gen(function* growFailures() {
      const shell = yield* localExec;

      const failed = [
        { error: true },
        { response: {} },
        { response: { count: 0 } },
        { response: { count: "8" } },
        { response: { count: 8, extra: 1 } },
        { response: [] },
      ];

      for (const failure of failed) {
        const result = yield* runGrow(shell, {
          ...failure,
          free: 100,
          mode: "grow",
          writable: 1,
        });

        expect(result.posts).toEqual([growUrl]);
        expect(result.code).toBe(1);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "diagnose and retain-free reads never POST, and the alarm edges hold",
  () =>
    Effect.gen(function* alarmEdges() {
      const shell = yield* localExec;

      for (const [free, writable, alarm] of [
        [15, 0, true],
        [16, 0, true],
        [64, 0, true],
        [65, 0, false],
        [64, 5, true],
        [65, 5, false],
      ] as const) {
        const result = yield* runGrow(shell, {
          free,
          mode: "diagnose",
          writable,
        });

        expect(result.posts).toEqual([]);
        expect(result.code).toBe(alarm ? 1 : 0);
        expect(result.first.alarm).toBe(alarm);
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "small instances scale the floor to max/8 and the critical level to max/32",
  () =>
    Effect.gen(function* smallFloor() {
      const shell = yield* localExec;

      for (const [max, free, writable, mode, alarm, grows] of [
        [64, 14, 0, "diagnose", false, 0],
        [64, 8, 0, "diagnose", true, 0],
        [64, 9, 5, "diagnose", false, 0],
        [64, 1, 0, "diagnose", true, 0],
        [64, 14, 0, "grow", false, 6],
        [64, 20, 1, "grow", false, 8],
        [64, 8, 0, "grow", false, 0],
        [64, 9, 4, "grow", false, 0],
        [8, 3, 0, "grow", false, 1],
        [8, 2, 0, "grow", false, 0],
        [2048, 64, 0, "diagnose", true, 0],
        [2048, 65, 0, "grow", false, 1],
      ] as const) {
        const result = yield* runGrow(shell, { free, max, mode, writable });

        expect(result.posts).toEqual(grows > 0 ? [growUrlFor(grows)] : []);

        if (mode === "diagnose") {
          expect(result.first.alarm).toBe(alarm);
          expect(result.code).toBe(alarm ? 1 : 0);
        } else {
          expect(result.first.grew).toBe(grows);
          expect(result.first.after?.freeVolumeSlots).toBe(free - grows);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "the grow timer runs every ten minutes without touching celld or weed",
  () =>
    Effect.gen(function* growUnits() {
      const unit = storageGrowUnit("/home/example", "/opt/example/m.py", ["a"]);
      const timer = storageGrowTimer("/home/example", ["a"]);

      yield* validateUnit(unit);
      yield* validateUnit(timer);
      expect(renderUnit(timer)).toContain("OnCalendar=*:0/10");
      expect(renderUnit(unit)).toContain(
        'ExecStart=/usr/bin/python3 "/opt/example/m.py" grow'
      );
      expect(renderUnit(unit)).toContain("Restart=no");
    })
);
