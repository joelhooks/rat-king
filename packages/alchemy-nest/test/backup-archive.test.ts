import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";
import { s3Script } from "../src/s3-script.ts";

const archiveFixture = String.raw`
import base64, contextlib, http.client, io, json, pathlib, subprocess, sys, tarfile, tempfile, urllib.parse
script, object_script, encoded = sys.argv[1:4]
payload = base64.b64decode(encoded)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    import os
    os.umask(0o002)
    data, backup, config = root/'data', root/'backup', root/'s3.json'
    (data/'celld').mkdir(parents=True)
    (data/'celld/state').write_bytes(payload)
    (data/'seaweedfs').mkdir()
    (data/'seaweedfs/raw-volume').write_text('peer secret must never enter backup')
    (data/'credentials.json').write_text('excluded invented key')
    backup.mkdir()
    original = subprocess.run
    def command(argv, **kwargs):
        if argv[0] == 'findmnt':
            return subprocess.CompletedProcess(argv, 0, str(backup) + '\n', '')
        if argv[0] == 'systemctl':
            return subprocess.CompletedProcess(argv, 0, 'ActiveState=inactive\nResult=success\n', '')
        return original(argv, **kwargs)
    subprocess.run = command
    def run(action, target, *args):
        sys.argv = ['backup', action, str(target), str(backup), *args]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                exec(compile(script, 'backup-adapter', 'exec'), {})
            except SystemExit as stopped:
                if stopped.code not in (None, 0):
                    raise
        return output.getvalue().strip()
    objects = {'cells/example/state': payload, 'fleet/peer-auth.json': b'forbidden peer key'}
    expected_access = 'source-access'
    class Connection:
        def __init__(self, *args, **kwargs): pass
        def request(self, method, url, body, headers):
            assert ('Credential=' + expected_access + '/') in headers['authorization']
            self.method, self.url, self.body = method, url, body
        def getresponse(self):
            if '?' in self.url:
                body = ('<ListBucketResult>' + ''.join('<Contents><Key>'+key+'</Key></Contents>' for key in objects) + '<IsTruncated>false</IsTruncated></ListBucketResult>').encode()
            else:
                key = urllib.parse.unquote(self.url.split('/bucket/', 1)[1])
                assert key != 'fleet/peer-auth.json', 'Peer key was accessed for export/import'
                if self.method == 'PUT': objects[key] = self.body
                body = objects[key] if self.method == 'GET' else b''
            response = io.BytesIO(body)
            response.status = 200
            return response
        def close(self): pass
    http.client.HTTPConnection = Connection
    def write_credentials():
        config.write_text(json.dumps({'identities':[{'credentials':[{'accessKey':expected_access,'secretKey':'invented-secret-'+'x'*256}]}]}))
    def object_action(action, target):
        sys.argv = ['s3', str(config), 'http://127.0.0.1:18333', 'bucket', action, str(target)]
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(object_script, 'object-adapter', 'exec'), {})
    write_credentials()
    staging = pathlib.Path(run('stage', data))
    object_action('export', staging/'objects.tar')
    run('snapshot', data, str(staging))
    run('publish', data, str(staging), 'invented-version', 'invented-commit')
    snapshots = list(backup.iterdir())
    assert len(snapshots) == 1
    source = snapshots[0]
    assert set(path.name for path in source.iterdir()) == {'objects.tar', 'celld.tar', 'manifest.json'}
    with tarfile.open(source/'objects.tar') as archive:
        index = json.load(archive.extractfile('index.json'))
        assert [entry['key'] for entry in index['objects']] == ['cells/example/state']
    with tarfile.open(source/'celld.tar') as archive:
        assert set(archive.getnames()) == {'celld', 'celld/state'}
    restored = root/'restored'
    selected = run('restore-preflight', restored)
    assert not restored.exists(), 'Preflight gained directory ownership'
    restored.mkdir(mode=0o700)
    (restored/'celld').mkdir(mode=0o700)
    run('restore', restored, selected)
    assert (restored/'celld').stat().st_mode & 0o777 == 0o700
    assert (restored/'celld/state').stat().st_mode & 0o777 == 0o600
    assert (restored/'celld/state').read_bytes() == payload
    objects = {}
    expected_access = 'fresh-target-access'
    write_credentials()
    object_action('import', restored/'.mailbox-restore-objects.tar')
    assert objects == {'cells/example/state': payload}
    assert not (restored/'seaweedfs').exists()
    try:
        run('restore', restored, selected)
        raise AssertionError('Occupied root was overwritten')
    except RuntimeError:
        assert (restored/'celld/state').read_bytes() == payload
    (data/'celld/s3.json').write_text('forbidden config')
    try:
        run('preflight', data)
        raise AssertionError('Known key file was accepted')
    except RuntimeError:
        pass
    with (source/'celld.tar').open('ab') as stream:
        stream.write(b'corrupt')
    refused = root/'refused'
    try:
        run('restore-preflight', refused)
        raise AssertionError('Corrupt archive was restored')
    except RuntimeError:
        assert not refused.exists()
    assert not staging.exists()
    print('LOGICAL_DATA_ONLY_ROUNDTRIP_AND_REFUSALS_PASSED')
`;

it.effect.prop(
  "logical snapshot excludes peer/store keys, imports with fresh credentials and refuses corruption or occupied roots",
  {
    payload: Arbitrary.schema(Schema.Uint8Array),
  },
  ({ payload }) =>
    Effect.gen(function* archiveRoundtrip() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        archiveFixture,
        backupScript,
        s3Script,
        Buffer.from(payload).toString("base64"),
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(
        "LOGICAL_DATA_ONLY_ROUNDTRIP_AND_REFUSALS_PASSED"
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
