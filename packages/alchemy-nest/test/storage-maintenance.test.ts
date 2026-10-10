import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";
import { nodeUnit } from "../src/service-units.ts";
import { storageMaintenanceScript } from "../src/storage-maintenance-script.ts";
import {
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
expected = set(path for age, path in zip(payload['ages'], paths) if age > 7)
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
    return {'Topology': {'Free': payload['free'], 'Max': 64, 'Layouts': [
        dict(collection='', replication='000', ttl='', writables=list(range(1, payload['writable'] + 1))),
        dict(collection='example', replication='000', ttl='', writables=[99]),
        dict(collection='', replication='000', ttl='7d', writables=[100])]}}
signal = namespace['diagnostic'](topology)
assert reads == [('http://127.0.0.1:19333/dir/status', 'GET')]
assert signal['defaultCollectionWritableVolumes'] == payload['writable']
assert signal['freeVolumeSlots'] == payload['free']
assert signal['alarm'] == (payload['free'] < 8 or payload['writable'] == 0)
namespace['diagnostic'] = lambda: signal
sys.argv = ['maintenance', 'diagnose']
out, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    result = namespace['main']()
assert result == int(signal['alarm'])
assert json.loads(out.getvalue()) == signal
assert ('storage has no writable volume' in err.getvalue()) == (payload['writable'] == 0)
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
      Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 0 }))
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
        "Environment=CELLD_LTX_RETENTION_SECS=604800"
      );
      expect(renderUnit(node)).toContain(
        "Environment=CELLD_SHUTDOWN_TOTAL_MS=8000"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
