import { cacheIoScript } from "../../packages/alchemy-nest/src/cache-io-script.ts";
import { objectArchiveScript } from "../../packages/alchemy-nest/src/object-archive-script.ts";

export const backupScript = String.raw`
import datetime, hashlib, json, os, pathlib, re, signal, sqlite3, stat, subprocess, sys, tarfile, tempfile, time, uuid
operation, data_arg, backup_arg = sys.argv[1:4]
data, backup = pathlib.Path(data_arg), pathlib.Path(backup_arg)
${cacheIoScript}
${objectArchiveScript}
BACKUP_NAME = r'[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{32}'
def complete_backup(path):
    regular = lambda name: (path / name).is_file() and not (path / name).is_symlink()
    return bool(re.fullmatch(BACKUP_NAME, path.name)) and not path.is_symlink() and path.is_dir() and regular('manifest.json') and any(all(regular(name) for name in pair) for pair in [('objects.tar', 'celld.tar'), ('objects.tar.gz', 'celld.tar.gz')])
def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def cleanup_partials(parent, pattern, allowed, preserve_manifest=False):
    for candidate in parent.iterdir():
        if not re.fullmatch(pattern, candidate.name) or candidate.is_symlink() or not candidate.is_dir():
            continue
        if preserve_manifest and ((candidate / 'manifest.json').exists() or not any((candidate / name).is_file() for name in ['objects.tar', 'objects.tar.gz'])):
            continue
        children = []
        for child in candidate.iterdir():
            if child.name not in allowed or not child.is_file() or child.is_symlink():
                break
            children.append(child)
        else:
            for child in children:
                child.unlink()
            candidate.rmdir()
def fail(reason):
    raise RuntimeError(reason)
def no_links(path):
    if not path.is_absolute() or '..' in path.parts:
        fail('Expected canonical absolute path')
    for candidate in [path, *path.parents]:
        if candidate.is_symlink():
            fail('Symlink path refused')
    if path.resolve() != path:
        fail('Noncanonical path refused')
def mounted_share():
    no_links(backup)
    parent = backup
    while not parent.exists():
        parent = parent.parent
    result = subprocess.run(['findmnt', '-n', '-t', 'cifs', '-o', 'TARGET', '--target', str(parent)], capture_output=True, text=True, check=True)
    mount = pathlib.Path(result.stdout.strip())
    if not mount.is_absolute() or not (backup == mount or mount in backup.parents):
        fail('Backup path is not on the existing SMB mount')
    backup.mkdir(parents=True, exist_ok=True)
def inactive(restoring=False, store_stopped=False):
    units = ['rat-king-celld.service', 'rat-king-seaweedfs.service'] if store_stopped else ['rat-king-celld.service']
    for unit in units:
        result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState,Result'], capture_output=True, text=True, check=True)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if fields.get('ActiveState') not in ['inactive', 'failed']:
            fail('Snapshot/restore requires its writers stopped')
        if not restoring and (fields.get('ActiveState') != 'inactive' or fields.get('Result') != 'success'):
            fail('Backup refuses a failed or timed-out shutdown')
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        stream = CacheReader(source)
        for chunk in iter(lambda: stream.read(COPY_CHUNK), b''):
            h.update(chunk)
        stream.release()
    return h.hexdigest()
def checked_tree(root):
    no_links(root)
    if not root.is_dir():
        fail('Missing data directory')
    for path in root.rglob('*'):
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            fail('Special data file refused')
        require_safe_key(path.relative_to(root).as_posix())
def staging_path():
    staging = pathlib.Path(sys.argv[4])
    no_links(staging)
    if staging.parent != data or not staging.name.startswith('.mailbox-backup-'):
        fail('Foreign staging path refused')
    return staging
def validate_celld(archive):
    with tempfile.TemporaryDirectory() as tmp, sqlite3.connect(str(pathlib.Path(tmp) / 'seen.sqlite')) as seen:
        seen.execute('PRAGMA cache_size=-2048')
        seen.execute('CREATE TABLE names (name TEXT PRIMARY KEY)')
        for member in archive:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'celld' or not (member.isdir() or member.isfile()):
                fail('Unsafe celld snapshot member refused')
            require_safe_key(member.name)
            seen.execute('INSERT INTO names VALUES (?)', (member.name,))
            archive.members.clear()
no_links(data)
if operation not in {'snapshot', 'arm', 'disarm'}:
    mounted_share()
if operation == 'preflight':
    checked_tree(data / 'celld')
    print('BACKUP_PREFLIGHT_PASSED')
elif operation == 'arm':
    result = subprocess.run(['systemctl', '--user', 'show', 'rat-king-mailbox-backup.service', '--property=ExecMainStartTimestampMonotonic', '--value'], capture_output=True, text=True, check=True)
    started = int(result.stdout.strip())
    age = time.monotonic_ns() // 1000 - started
    if started <= 0 or age < 0 or age >= 20 * 60 * 1000000:
        fail('Refusing late celld stop: unit age must be below 20 minutes')
    marker = data / '.mailbox-backup-restart-required'
    with marker.open('x') as stream:
        stream.write('restart required\n')
        stream.flush()
        os.fsync(stream.fileno())
    if time.monotonic_ns() // 1000 - started >= 20 * 60 * 1000000:
        fail('Restart marker sync exhausted early-stop budget')
    print('BACKUP_RECOVERY_ARMED')
elif operation == 'disarm':
    (data / '.mailbox-backup-restart-required').unlink(missing_ok=True)
    print('BACKUP_RECOVERY_DISARMED')
elif operation == 'stage':
    staging = data / ('.mailbox-backup-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    print(str(staging))
elif operation == 'snapshot':
    signal.signal(signal.SIGALRM, lambda *_: fail('Local snapshot exceeded 5 second stop budget'))
    signal.alarm(5)
    inactive()
    staging = staging_path()
    checked_tree(data / 'celld')
    target = staging / 'celld.tar'
    with target.open('xb') as destination:
        writer = CacheWriter(destination)
        with tarfile.open(fileobj=writer, mode='w|') as archive:
            root = data / 'celld'
            archive.add(root, arcname='celld', recursive=False)
            for directory, _, files in os.walk(root):
                parent = pathlib.Path(directory)
                if parent != root:
                    archive.add(parent, arcname=parent.relative_to(data).as_posix(), recursive=False)
                for name in files:
                    path = parent / name
                    info = archive.gettarinfo(str(path), arcname=path.relative_to(data).as_posix())
                    with path.open('rb') as source:
                        reader = CacheReader(source)
                        archive.addfile(info, reader)
                        reader.release()
                    archive.members.clear()
        writer.sync()
    os.chmod(target, 0o600)
    print('SNAPSHOT_KEY_PATTERN_ASSERTION_PASSED')
elif operation == 'publish':
    staging = staging_path()
    for name in ['objects.tar', 'celld.tar']:
        source = staging / name
        if source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
            fail('Invalid local snapshot archive')
    compressed_hashes = {}
    for name in ['objects.tar', 'celld.tar']:
        compressed_hashes[name + '.gz'] = cache_compress(staging / name, staging / (name + '.gz'))
    with cache_tar(staging / 'objects.tar.gz') as archive:
        validate_export(archive)
    with cache_tar(staging / 'celld.tar.gz') as archive:
        validate_celld(archive)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    target = backup / (stamp + '-' + uuid.uuid4().hex)
    pending = backup / ('.mailbox-publish-' + target.name)
    pending.mkdir(mode=0o700)
    hashes = {}
    for name in ['objects.tar.gz', 'celld.tar.gz']:
        source, destination = staging / name, pending / name
        if not source.is_file() or source.is_symlink():
            fail('Invalid snapshot archive')
        expected = compressed_hashes[name]
        with source.open('rb') as src, destination.open('xb') as dst:
            copied = cache_copy(src, dst, window=PUBLISH_WINDOW)
        if copied != expected:
            fail('Published stream checksum mismatch')
        hashes[name] = expected
    manifest = {'format': 3, 'createdAt': stamp, 'version': sys.argv[5], 'commit': sys.argv[6], 'sha256': hashes}
    with (pending / 'manifest.pending').open('x') as stream:
        json.dump(manifest, stream)
        stream.flush()
        os.fsync(stream.fileno())
    (pending / 'manifest.pending').rename(pending / 'manifest.json')
    sync_directory(pending)
    if target.exists() or target.is_symlink():
        fail('Refusing occupied publication name')
    pending.rename(target)
    sync_directory(backup)
    # Only recognized staging and partial publication directories, after success.
    cleanup_partials(data, r'\.mailbox-backup-[0-9a-f]{32}', {'objects.tar', 'celld.tar', 'objects.tar.gz', 'celld.tar.gz', 'objects.tar.sqlite', 'objects.tar.sqlite-journal', 'objects.tar.data'})
    publish_files = {'objects.tar', 'celld.tar', 'objects.tar.gz', 'celld.tar.gz', 'manifest.pending', 'manifest.json'}
    cleanup_partials(backup, r'\.mailbox-publish-' + BACKUP_NAME, publish_files)
    cleanup_partials(backup, BACKUP_NAME, publish_files, preserve_manifest=True)
    print('BACKUP_PUBLISHED ' + target.name)
elif operation in ['restore-preflight', 'restore']:
    if operation == 'restore-preflight':
        inactive(restoring=True, store_stopped=True)
        if data.exists() and any(data.iterdir()):
            fail('Restore requires a fresh empty data root; existing data is preserved')
    else:
        inactive(restoring=True)
        if not (data / 'celld').is_dir() or (data / 'celld').stat().st_mode & 0o777 != 0o700:
            fail('Restore requires the resource-owned celld directory at mode 0700')
        if any((data / 'celld').iterdir()):
            fail('Restore refuses an occupied celld directory')
        if any(path.name not in {'celld', 'seaweedfs'} for path in data.iterdir()):
            fail('Restore refuses undeclared data-root children')
    candidates = sorted([path for path in backup.iterdir() if complete_backup(path)], reverse=True)
    if not candidates:
        fail('No complete backup')
    if operation == 'restore':
        selected = sys.argv[4]
        if pathlib.PurePosixPath(selected).name != selected or selected in {'.', '..'}:
            fail('Invalid backup selection')
        source = backup / selected
        if source not in candidates:
            fail('Selected backup is not complete')
    else:
        source = candidates[0]
    no_links(source)
    manifest_path = source / 'manifest.json'
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 16384:
        fail('Invalid backup manifest')
    manifest = json.loads(manifest_path.read_text())
    objects_name, celld_name = ('objects.tar', 'celld.tar') if manifest.get('format') == 2 else ('objects.tar.gz', 'celld.tar.gz')
    if manifest.get('format') not in {2, 3} or set(manifest.get('sha256', {})) != {objects_name, celld_name}:
        fail('Unsupported backup manifest')
    for name in [objects_name, celld_name]:
        archive_path = source / name
        if archive_path.is_symlink() or digest(archive_path) != manifest['sha256'][name]:
            fail('Restore checksum mismatch')
    with cache_tar(source / objects_name) as archive:
        validate_export(archive)
    with cache_tar(source / celld_name) as archive:
        validate_celld(archive)
    if operation == 'restore-preflight':
        print(source.name)
        sys.exit(0)
    no_links(data / 'celld')
    def secured_member(member, destination):
        safe = tarfile.data_filter(member, destination)
        return safe.replace(mode=0o700 if safe.isdir() else 0o600)
    with cache_tar(source / celld_name) as archive:
        for member in archive:
            archive.extract(member, data, filter=secured_member)
            archive.members.clear()
    # Never rely on the operator's umask, including when it is 002.
    os.chmod(data / 'celld', 0o700)
    if (data / 'celld').stat().st_mode & 0o777 != 0o700:
        fail('Restored celld directory mode assertion failed')
    target = data / '.mailbox-restore-objects.tar'
    with (source / objects_name).open('rb') as src, target.open('xb') as dst:
        cache_copy(src, dst)
    os.chmod(target, 0o600)
    print('BACKUP_RESTORED ' + source.name)
else:
    fail('Unknown backup action')
`;
