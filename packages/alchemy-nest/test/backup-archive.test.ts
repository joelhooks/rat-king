import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";
import { s3Script } from "../src/s3-script.ts";

const archiveFixture = String.raw`
import base64, contextlib, gzip, hashlib, http.client, io, json, pathlib, subprocess, sys, tarfile, tempfile, urllib.parse
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
    objects = {}
    expected_access = 'source-access'
    class Connection:
        def __init__(self, *args, **kwargs): pass
        def request(self, method, url, body, headers):
            assert ('Credential=' + expected_access + '/') in headers['authorization']
            self.method, self.url, self.body = method, url, body.read() if hasattr(body, 'read') else body
        def getresponse(self):
            if '?' in self.url:
                body = ('<ListBucketResult>' + ''.join('<Contents><Key>'+key+'</Key><ETag>&quot;'+hashlib.md5(objects[key]).hexdigest()+'&quot;</ETag></Contents>' for key in sorted(objects)) + '<IsTruncated>false</IsTruncated></ListBucketResult>').encode()
            else:
                key = urllib.parse.unquote(self.url.split('/bucket/', 1)[1])
                if self.method == 'PUT': objects[key] = self.body
                body = objects[key] if self.method == 'GET' else b''
            response = io.BytesIO(body)
            response.status = 200
            response.getheader = lambda name, default='': '"'+hashlib.md5(body).hexdigest()+'"' if name == 'ETag' else default
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
    # Build a format-3 backup by hand, as the retired exporter wrote it.
    def member(archive, name, value):
        info = tarfile.TarInfo(name)
        info.size = len(value)
        archive.addfile(info, io.BytesIO(value))
    source = backup / ('20000102T030405.123456Z-' + 'd' * 32)
    source.mkdir()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        member(archive, 'format.json', b'{"format":2}')
        entry = {'key': 'cells/example/state', 'member': 'objects/'+hashlib.sha256(b'cells/example/state').hexdigest()+'.blob', 'sha256': hashlib.sha256(b'changed').hexdigest()}
        member(archive, 'entry.json', json.dumps(entry).encode())
        member(archive, entry['member'], b'changed')
    (source/'objects.tar.gz').write_bytes(gzip.compress(stream.getvalue()))
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        info = tarfile.TarInfo('celld'); info.type = tarfile.DIRTYPE
        archive.addfile(info)
        member(archive, 'celld/state', payload)
    (source/'celld.tar.gz').write_bytes(gzip.compress(stream.getvalue()))
    (source/'manifest.json').write_text(json.dumps({'format': 3, 'sha256': {name: hashlib.sha256((source/name).read_bytes()).hexdigest() for name in ['objects.tar.gz', 'celld.tar.gz']}}))
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
    assert objects == {'cells/example/state': b'changed'}
    # Existing format-1 backups still import with fresh credentials.
    legacy = root/'legacy.tar'
    entry = {'key': 'cells/legacy', 'member': 'objects/'+hashlib.sha256(b'cells/legacy').hexdigest()+'.blob', 'sha256': hashlib.sha256(payload).hexdigest()}
    with tarfile.open(legacy, 'w') as archive:
        for name, value in [(entry['member'], payload), ('index.json', json.dumps({'format':1,'objects':[entry]}).encode())]:
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
    object_action('import', legacy)
    assert objects['cells/legacy'] == payload
    # Format-2 manifests and uncompressed tar pairs remain restorable.
    old = backup / ('20000102T030405.123456Z-' + 'c' * 32)
    old.mkdir()
    hashes = {}
    for name in ['objects.tar', 'celld.tar']:
        with gzip.open(source/(name+'.gz'), 'rb') as stream:
            (old/name).write_bytes(stream.read())
        hashes[name] = hashlib.sha256((old/name).read_bytes()).hexdigest()
    (old/'manifest.json').write_text(json.dumps({'format':2,'sha256':hashes}))
    old_target = root/'old-target'
    (old_target/'celld').mkdir(parents=True, mode=0o700)
    run('restore', old_target, old.name)
    assert (old_target/'celld/state').read_bytes() == payload
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
    with (source/'celld.tar.gz').open('ab') as stream:
        stream.write(b'corrupt')
    refused = root/'refused'
    try:
        run('restore-preflight', refused)
        raise AssertionError('Corrupt archive was restored')
    except RuntimeError:
        assert not refused.exists()
    print('LEGACY_RESTORE_AND_REFUSALS_PASSED')
`;

it.effect.prop(
  "legacy format-2/3 backups still restore and import with fresh credentials, and corruption or occupied roots are refused",
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
      expect(result.stdout.trim()).toBe("LEGACY_RESTORE_AND_REFUSALS_PASSED");
    }).pipe(Effect.provide(NodeServices.layer))
);
