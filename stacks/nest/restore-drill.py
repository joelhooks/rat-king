"""Restore an archive in an owned, network-isolated namespace. Never import production env."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid

BACKUP_NAME = re.compile(r'[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{32}')
REQUIRED_PROOFS = ('sha256', 'inventories', 'health', 'message', 'lease', 'mailboxCounts')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def canonical(path):
    path = pathlib.Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'Absolute canonical path required')
    require(all(not p.is_symlink() for p in (path, *path.parents)), 'Symlink path refused')
    require(path.resolve() == path, 'Noncanonical path refused')
    return path


def select_archive(share):
    canonical(share)
    candidates = sorted((p for p in share.iterdir() if BACKUP_NAME.fullmatch(p.name)
                         and not p.is_symlink() and p.is_dir()
                         and (p/'manifest.json').is_file() and not (p/'manifest.json').is_symlink()), reverse=True)
    require(candidates, 'No published mailbox backup')
    newest = candidates[0]
    require((newest/'mailbox.tar.gz').is_file() and not (newest/'mailbox.tar.gz').is_symlink(),
            'Newest publication is incomplete; refusing fallback')
    return newest


def create_root(parent, run_id):
    canonical(parent)
    require(re.fullmatch('[a-f0-9]{32}', run_id), 'Invalid run id')
    root = parent/('restore-drill-' + run_id)
    root.mkdir(mode=0o700)
    (root/'.restore-drill-owner').write_text(run_id)
    info = root.stat()
    return root, (info.st_dev, info.st_ino)


def remove_root(root, run_id, identity):
    canonical(root)
    require(root.name == 'restore-drill-' + run_id, 'Foreign scratch root refused')
    info = root.stat()
    marker = root/'.restore-drill-owner'
    require((info.st_dev, info.st_ino) == tuple(identity) and marker.is_file()
            and not marker.is_symlink() and marker.read_text() == run_id, 'Scratch ownership proof failed')
    require(shutil.rmtree.avoids_symlink_attacks, 'Symlink-safe teardown unavailable')
    shutil.rmtree(root)
    require(not os.path.lexists(root), 'Scratch root remains')


def new_receipt(run_id):
    return {'schemaVersion': 1, 'runId': run_id, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status': 'fail', 'archiveId': None, 'timings': {}, 'proofs': {}, 'teardown': {}, 'error': None}


def passed(receipt):
    return bool(receipt['archiveId']) and all(receipt['proofs'].get(k) for k in REQUIRED_PROOFS) and all(
        receipt['teardown'].get(k) is True for k in ('rootAbsent', 'unitAbsent', 'processesAbsent'))


def append_receipt(path, receipt):
    canonical(path)
    require(not path.exists() or path.is_file(), 'Receipt must be a regular file')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'Receipt must be a regular file')
        os.fchmod(stream.fileno(), 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(receipt, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def backup_idle():
    now = datetime.datetime.now(datetime.timezone.utc)
    require(not (now.hour == 10 and now.minute < 14), 'Nightly backup window; retry outside 10:00-10:14Z')
    result = subprocess.run(['systemctl', '--user', 'show', 'rat-king-mailbox-backup.service',
                             '-p', 'ActiveState', '--value'], capture_output=True, text=True, check=True)
    require(result.stdout.strip() in ('inactive', 'failed'), 'Mailbox backup running or state unknown')


def restore_archive(source, root):
    manifest_path = source/'manifest.json'
    require(manifest_path.stat().st_size <= 16384, 'Manifest too large')
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get('format') == 4 and set(manifest.get('trees', {})) == {'celld', 'seaweedfs'}
            and set(manifest.get('sha256', {})) == {'mailbox.tar.gz'}, 'Unsupported manifest')
    expected_bytes = manifest['bytes']['mailbox.tar.gz']
    require(type(expected_bytes) is int and expected_bytes > 0, 'Invalid archive bytes')
    expected_sha = manifest['sha256']['mailbox.tar.gz']
    require(re.fullmatch('[a-f0-9]{64}', expected_sha), 'Invalid archive digest')
    for tree in manifest['trees'].values():
        require(set(tree) == {'bytes', 'files', 'directories'} and all(type(v) is int and v >= 0 for v in tree.values()),
                'Invalid inventory')
    required = expected_bytes + sum(t['bytes'] for t in manifest['trees'].values())
    free_before = shutil.disk_usage(root).free
    require(free_before >= required * 1.2 + 1024**3, 'Insufficient scratch disk space')
    h = hashlib.sha256()
    size = 0
    archive_path = root/'mailbox.tar.gz'
    with (source/'mailbox.tar.gz').open('rb') as src, archive_path.open('xb') as dst:
        while chunk := src.read(8*1024*1024):
            h.update(chunk)
            size += len(chunk)
            dst.write(chunk)
    require(size == expected_bytes and h.hexdigest() == expected_sha, 'Archive checksum/size mismatch')
    counts = {name: dict(bytes=0, files=0, directories=0) for name in manifest['trees']}
    with tarfile.open(archive_path, 'r|gz') as archive:
        for member in archive:
            p = pathlib.PurePosixPath(member.name)
            require(not p.is_absolute() and '..' not in p.parts and p.parts and p.parts[0] in counts
                    and (member.isfile() or member.isdir()), 'Unsafe archive member')
            destination = root.joinpath(*p.parts)
            require(not os.path.lexists(destination), 'Duplicate archive member')
            if len(p.parts) > 1:
                counts[p.parts[0]]['directories' if member.isdir() else 'files'] += 1
                counts[p.parts[0]]['bytes'] += member.size if member.isfile() else 0
            require(all(value <= manifest['trees'][name][key] for name, tree in counts.items()
                        for key, value in tree.items()), 'Archive exceeds manifest inventory')
            safe = tarfile.data_filter(member, root).replace(mode=0o700 if member.isdir() else 0o600)
            archive.extract(safe, root, filter='data')
            archive.members.clear()
    require(counts == manifest['trees'], 'Archive inventories mismatch')
    # Check the actual extracted filesystem, not just tar headers.
    actual = {}
    for name in counts:
        tree = dict(bytes=0, files=0, directories=0)
        for folder, dirs, files in os.walk(root/name):
            tree['directories'] += len(dirs)
            tree['files'] += len(files)
            tree['bytes'] += sum((pathlib.Path(folder)/f).stat().st_size for f in files)
        actual[name] = tree
    require(actual == counts, 'Extracted inventories mismatch')
    return {'sha256': expected_sha, 'inventories': actual,
            'disk': {'freeBeforeBytes': free_before, 'requiredBytes': int(required * 1.2 + 1024**3)}}


def http_json(port, path, payload=None):
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + path,
                                     data=None if payload is None else json.dumps(payload).encode(),
                                     headers={'Accept': 'application/json', 'Content-Type': 'application/json'})
    with OPENER.open(request, timeout=20) as response:
        return json.load(response)


def wait_http(processes, port, path, timeout=120):
    deadline = time.monotonic() + timeout
    while True:
        require(all(p.poll() is None for p in processes), 'Scratch service exited')
        try:
            return http_json(port, path)
        except (OSError, ValueError):
            require(time.monotonic() < deadline, 'Scratch service readiness deadline')
            time.sleep(0.25)


def allocate_ports():
    reservations = []
    try:
        for _ in range(10):
            sock = socket.socket()
            sock.bind(('127.0.0.1', 0))
            reservations.append(sock)
        return [s.getsockname()[1] for s in reservations]
    finally:
        for sock in reservations:
            sock.close()


def inspect_mailboxes(root, internal, known_did=None):
    mailboxes = []
    newest = None
    lease = None
    for folder in sorted((root/'celld').glob('Mailbox:*')):
        # Route activation restores the current epoch from the copied bucket.
        http_json(internal, '/cell/' + folder.name)
        paths = list(folder.glob('ltx/e*/db.sqlite'))
        require(paths, 'Mailbox has no restored SQLite database')
        path = max(paths, key=lambda p: int(p.parent.name[1:]))
        with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'messages', 'metadata', 'events', 'lease'} <= tables:
                continue
            recipient = db.execute("SELECT value FROM metadata WHERE key='recipient'").fetchone()
            require(recipient, 'Mailbox recipient missing')
            did = recipient[0]
            count = db.execute('SELECT count(*) FROM events').fetchone()[0]
            messages = db.execute('SELECT count(*) FROM messages').fetchone()[0]
            mailboxes.append({'did': did, 'events': count, 'messages': messages})
            row = db.execute('SELECT tid,sender FROM messages ORDER BY tid DESC LIMIT 1').fetchone()
            if row and (newest is None or row[0] > newest['messageId']):
                newest = {'messageId': row[0], 'senderDid': row[1], 'recipientDid': did}
            if did == known_did:
                row = db.execute('SELECT value FROM lease WHERE singleton=1').fetchone()
                require(row, 'Known-name lease record missing')
                value = json.loads(row[0])
                require(value.get('leaseId') and type(value.get('generation')) is int and value.get('expiresAt'),
                        'Incomplete restored lease record')
                lease = {k: value[k] for k in ('did', 'leaseId', 'generation', 'expiresAt')}
    require(mailboxes and newest, 'No restored mailbox/message proof')
    if known_did is not None:
        require(lease and lease['did'] == known_did, 'Known-name lease proof missing')
    return {'mailboxes': mailboxes, 'newest': newest, 'lease': lease}


def worker(config, root):
    require([name for _, name in socket.if_nameindex()] == ['lo'], 'Private loopback namespace required')
    ports = allocate_ports()
    public, internal, filer, filer_grpc, master, master_grpc, s3, s3_grpc, volume, volume_grpc = ports
    access, secret = uuid.uuid4().hex, uuid.uuid4().hex + uuid.uuid4().hex
    credentials = root/'s3.json'
    credentials.write_text(json.dumps({'identities': [{'name': 'restore-drill', 'credentials': [
        {'accessKey': access, 'secretKey': secret}], 'actions': ['Admin', 'Read', 'Write', 'List', 'Tagging']}]}))
    env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'SENTRY_DSN': '', 'OTEL_SDK_DISABLED': 'true'}
    cmd = [config['weed'], 'server', '-ip=127.0.0.1', '-ip.bind=127.0.0.1', '-filer', '-s3',
           '-s3.port.iceberg=0', '-s3.port.lance=0', '-dir=' + str(root/'seaweedfs'),
           '-s3.config=' + str(credentials), '-filer.localSocket=' + str(root/'filer.sock'),
           '-master.telemetry=false', '-metricsPort=0', '-debug=false', '-volume.pprof=false',
           '-master.volumeSizeLimitMB=64', '-volume.max=512', '-volume.preStopSeconds=0']
    for flag, port in zip(('filer.port', 'filer.port.grpc', 'master.port', 'master.port.grpc',
                           's3.port', 's3.port.grpc', 'volume.port', 'volume.port.grpc'), ports[2:]):
        cmd.append('-' + flag + '=' + str(port))
    processes = []
    logs = []
    try:
        log = (root/'weed.log').open('w'); logs.append(log)
        processes.append(subprocess.Popen(cmd, cwd=root/'seaweedfs', env=env, stdout=log, stderr=subprocess.STDOUT))
        # Filer responds without S3 credentials; the application waits for actual bucket readiness.
        wait_http(processes, filer, '/?pretty=y')
        env.update(AWS_ACCESS_KEY_ID=access, AWS_SECRET_ACCESS_KEY=secret, AWS_REGION='us-east-1',
                   S3_ENDPOINT='http://127.0.0.1:' + str(s3), CELLD_BUCKET='s3://' + config['bucket'],
                   CELLD_OTEL='0', CELLD_TEST_DATA_DIR=str(root/'celld'), CELLD_WATCH=str(root/'celld'),
                   CELLD_SHUTDOWN_TOTAL_MS='8000', CELLD_READY_FLEET_GATE_MS='0', CELLD_TOKIO_THREADS='4',
                   CELLD_PLACEMENT_WEIGHT='1', CELLD_REBALANCE_INTERVAL_MS='0')
        log = (root/'celld.log').open('w'); logs.append(log)
        processes.append(subprocess.Popen([config['celld'], '--listen', '127.0.0.1:' + str(public),
                                           '--internal-listen', '127.0.0.1:' + str(internal)],
                                          cwd=root/'celld', env=env, stdout=log, stderr=subprocess.STDOUT))
        (root/'pids.json').write_text(json.dumps([p.pid for p in processes]))
        version = wait_http(processes, public, '/.well-known/rat-king/version')
        require(http_json(public, '/.well-known/celld/health').get('ok') is True, 'Health proof missing')
        # Activate and inspect restored actors without modifying mailbox records.
        inventory = inspect_mailboxes(root, internal)
        (root/'inventory.json').write_text(json.dumps(inventory))
        subprocess.run([config['node'], str(pathlib.Path(__file__).with_name('restore-drill-proof.mjs')),
                        str(root), str(public), str(internal), str(filer), config['bucket'], config['knownName']],
                       check=True, timeout=1200, env={'PATH': os.environ['PATH'], 'HOME': str(root)})
        result = json.loads((root/'api-proof.json').read_text())
        require(result.get('message') and result.get('mailboxCounts') and result.get('knownDid'), 'API proofs missing')
        lease_inventory = inspect_mailboxes(root, internal, result['knownDid'])
        result.update(health=version, lease=lease_inventory['lease'], ports=ports,
                      namespace=os.readlink('/proc/self/ns/net'))
        (root/'proof.json').write_text(json.dumps(result))
    finally:
        stopped = []
        for p in reversed(processes):
            if p.poll() is None:
                p.terminate()
            try:
                p.wait(timeout=25)
            except subprocess.TimeoutExpired:
                p.kill(); p.wait(timeout=10)
            stopped.append({'pid': p.pid, 'returncode': p.returncode})
        for log in logs:
            log.close()
        (root/'children-stopped.json').write_text(json.dumps(stopped))


def orchestrate(config, receipt_path):
    run_id = uuid.uuid4().hex
    receipt = new_receipt(run_id)
    start = time.monotonic()
    root = None
    unit = 'restore-drill-' + run_id + '.service'
    launched = False
    identity = None
    try:
        backup_idle()
        require(sys.platform == 'linux', 'Linux systemd isolation required')
        parent = canonical(config['scratchParent'])
        share = canonical(config['backupRoot'])
        inventory = json.loads(canonical(config['inventory']).read_text())
        production_roots = [canonical(node['dataRoot']) for node in inventory['nodes'].values()]
        for protected in [share, *production_roots]:
            require(parent != protected and protected not in parent.parents and parent not in protected.parents,
                    'Scratch parent overlaps backup or production data')
            require(receipt_path != protected and protected not in receipt_path.parents,
                    'Receipt overlaps backup or production data')
        source = select_archive(share)
        receipt['archiveId'] = source.name
        root, identity = create_root(parent, run_id)
        receipt['scratchRoot'] = str(root)
        receipt['disk'] = {'freeBeforeBytes': shutil.disk_usage(root).free}
        restored = restore_archive(source, root)
        receipt['disk'] = restored.pop('disk')
        receipt['proofs'].update(restored)
        receipt['timings']['restoreSeconds'] = round(time.monotonic() - start, 3)
        backup_idle()
        (root/'config.json').write_text(json.dumps(config))
        receipt['unit'] = unit
        launched = True
        command = ['sudo', '-n', 'systemd-run', '--unit=' + unit, '--collect', '--wait',
                   '--uid=' + str(os.getuid()), '-p', 'PrivateNetwork=yes', '-p', 'PrivateTmp=yes',
                   '-p', 'RuntimeMaxSec=2400', '-p', 'TimeoutStopSec=45', '-p', 'KillMode=control-group',
                   '-p', 'MemoryMax=6G', '-p', 'TasksMax=1024', '-p', 'Nice=10',
                   sys.executable, '-u', str(pathlib.Path(__file__).resolve()), 'worker', str(root)]
        outcome = subprocess.run(command, capture_output=True, text=True, timeout=2500)
        require(outcome.returncode == 0, 'Isolated drill worker failed (see retained receipt; no production changes)')
        proof = json.loads((root/'proof.json').read_text())
        receipt['proofs'].update({k: proof[k] for k in ('health', 'message', 'lease', 'mailboxCounts')})
        receipt['timings']['proofSeconds'] = round(time.monotonic() - start - receipt['timings']['restoreSeconds'], 3)
        receipt['isolation'] = {k: proof[k] for k in ('ports', 'namespace')}
    except BaseException as error:
        receipt['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        cleanup_start = time.monotonic()
        try:
            if launched:
                subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], capture_output=True, timeout=60)
                observed = subprocess.run(['systemctl', 'show', unit, '-p', 'LoadState', '--value'],
                                          capture_output=True, text=True, timeout=20)
                receipt['teardown']['unitAbsent'] = observed.stdout.strip() == 'not-found'
                # The cgroup must be absent/empty, not merely an inactive unit.
                group = pathlib.Path('/sys/fs/cgroup/system.slice')/unit
                receipt['teardown']['processesAbsent'] = not group.exists() or all(
                    not path.read_text().strip() for path in group.rglob('cgroup.procs'))
                if root is not None and (root/'children-stopped.json').is_file():
                    receipt['teardown']['children'] = json.loads((root/'children-stopped.json').read_text())
                if root is not None and (root/'worker-error.json').is_file():
                    receipt['workerError'] = json.loads((root/'worker-error.json').read_text())
            else:
                receipt['teardown'].update(unitAbsent=True, processesAbsent=True)
            require(receipt['teardown'].get('processesAbsent') and receipt['teardown'].get('unitAbsent'),
                    'Service teardown unproven; retaining scratch root')
            if root is not None:
                remove_root(root, run_id, identity)
            receipt['teardown']['rootAbsent'] = root is None or not os.path.lexists(root)
        except BaseException as error:
            receipt['teardown']['error'] = str(error)
        receipt['timings']['teardownSeconds'] = round(time.monotonic() - cleanup_start, 3)
        receipt['timings']['totalSeconds'] = round(time.monotonic() - start, 3)
        if root is not None:
            receipt.setdefault('disk', {})['freeAfterBytes'] = shutil.disk_usage(root.parent).free
        receipt['status'] = 'pass' if receipt['error'] is None and passed(receipt) else 'fail'
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        append_receipt(receipt_path, receipt)
        print(json.dumps(receipt, sort_keys=True), flush=True)
    return 0 if receipt['status'] == 'pass' else 1


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit('Drill terminated'))
    if sys.argv[1] == 'worker':
        root = canonical(sys.argv[2])
        try:
            worker(json.loads((root/'config.json').read_text()), root)
        except BaseException as error:
            (root/'worker-error.json').write_text(json.dumps({'type': type(error).__name__, 'reason': str(error)}))
            raise
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('receipt')
    args = parser.parse_args()
    config = json.loads(args.config)
    receipt_path = canonical(args.receipt)
    # Serialize drills without touching the backup's lock or any production file.
    lock_fd = os.open(str(receipt_path) + '.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return orchestrate(config, receipt_path)


if __name__ == '__main__':
    sys.exit(main())
