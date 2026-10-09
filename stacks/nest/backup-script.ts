import { cacheIoScript } from "../../packages/alchemy-nest/src/cache-io-script.ts";
import { objectArchiveScript } from "../../packages/alchemy-nest/src/object-archive-script.ts";

export const backupScript = String.raw`
import datetime, gzip, hashlib, json, os, pathlib, re, shutil, signal, sqlite3, stat, subprocess, sys, tarfile, tempfile, time, uuid
operation, data_arg, backup_arg = sys.argv[1:4]
data, backup = pathlib.Path(data_arg), pathlib.Path(backup_arg)
${cacheIoScript}
${objectArchiveScript}
BACKUP_NAME = r'[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{32}'
PUBLISH_PREFIX = '.mailbox-publish-'
SNAPSHOT_ROOTS = ['seaweedfs', 'celld']
SNAPSHOT_ARCHIVE = 'mailbox.tar.gz'
# Copy and verify both stopped data directories inside this budget, or fail and restart.
SNAPSHOT_BUDGET = 20
FICLONE = 0x40049409
LEGACY_STAGING_FILES = {'objects.tar', 'celld.tar', 'objects.tar.gz', 'celld.tar.gz', 'objects.tar.sqlite', 'objects.tar.sqlite-journal', 'objects.tar.data'}
STAGING_FILES = LEGACY_STAGING_FILES | {'snapshot.json', 'archive.json', SNAPSHOT_ARCHIVE}
PUBLISH_FILES = {'objects.tar', 'celld.tar', 'objects.tar.gz', 'celld.tar.gz', SNAPSHOT_ARCHIVE, 'manifest.pending', 'manifest.json'}
def regular(path):
    return path.is_file() and not path.is_symlink()
def legacy_backup(path):
    return any(all(regular(path / name) for name in pair) for pair in [('objects.tar', 'celld.tar'), ('objects.tar.gz', 'celld.tar.gz')])
def snapshot_backup(path):
    return regular(path / SNAPSHOT_ARCHIVE)
def complete_backup(path, shape=None):
    if not re.fullmatch(BACKUP_NAME, path.name) or path.is_symlink() or not path.is_dir() or not regular(path / 'manifest.json'):
        return False
    return (shape or (lambda candidate: legacy_backup(candidate) or snapshot_backup(candidate)))(path)
def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def write_synced(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
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
def tree_stats(root, key_names=False):
    # Regular files and directories only. Counts are the copy's acceptance check.
    no_links(root)
    if not root.is_dir():
        fail('Missing data directory')
    files = directories = size = 0
    for directory, names, entries in os.walk(root):
        for name in names + entries:
            path = pathlib.Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                directories += 1
            elif stat.S_ISREG(mode):
                files += 1
                size += path.lstat().st_size
            else:
                fail('Special data file refused')
            if key_names:
                require_safe_key(path.relative_to(root).as_posix())
    return {'bytes': size, 'directories': directories, 'files': files}
def clone_file(source, destination):
    # A reflink shares extents and writes no data; otherwise copy with bounded file cache.
    with source.open('rb') as src, destination.open('xb') as dst:
        try:
            import fcntl
            fcntl.ioctl(dst.fileno(), FICLONE, src.fileno())
            return
        except (ImportError, OSError):
            pass
        # Stop-window CPU is capped; counts and bytes are the acceptance check, not a hash.
        cache_copy(src, dst, hashed=False)
def copy_tree(source, target):
    target.mkdir(mode=0o700)
    directories = [(source, target)]
    for directory, names, entries in os.walk(source):
        parent = pathlib.Path(directory)
        copied = target / parent.relative_to(source)
        names.sort()
        for name in names:
            (copied / name).mkdir(mode=0o700)
            directories.append((parent / name, copied / name))
        for name in sorted(entries):
            if not stat.S_ISREG((parent / name).lstat().st_mode):
                fail('Special data file refused')
            clone_file(parent / name, copied / name)
            shutil.copystat(parent / name, copied / name, follow_symlinks=False)
    for original, copied in reversed(directories):
        shutil.copystat(original, copied, follow_symlinks=False)
def add_tree(archive, root, name):
    archive.add(root, arcname=name, recursive=False)
    for directory, names, entries in os.walk(root):
        names.sort()
        parent = pathlib.Path(directory)
        for child in names:
            archive.add(parent / child, arcname=name + '/' + (parent / child).relative_to(root).as_posix(), recursive=False)
        for child in sorted(entries):
            path = parent / child
            info = archive.gettarinfo(str(path), arcname=name + '/' + path.relative_to(root).as_posix())
            if not info.isfile():
                fail('Special data file refused')
            with path.open('rb') as source:
                reader = CacheReader(source)
                archive.addfile(info, reader)
                reader.release()
            archive.members.clear()
def snapshot_members(path, trees):
    # Full inflate with CRC check; only regular files and directories under the snapshot roots.
    counts = {name: {'bytes': 0, 'directories': 0, 'files': 0} for name in SNAPSHOT_ROOTS}
    with cache_tar(path) as archive:
        for member in archive:
            parts = pathlib.PurePosixPath(member.name).parts
            if member.name.startswith('/') or '..' in parts or not parts or parts[0] not in SNAPSHOT_ROOTS or not (member.isdir() or member.isfile()):
                fail('Unsafe snapshot member refused')
            if len(parts) > 1:
                counts[parts[0]]['directories' if member.isdir() else 'files'] += 1
                counts[parts[0]]['bytes'] += member.size if member.isfile() else 0
            archive.members.clear()
    if counts != trees:
        fail('Snapshot archive does not match its manifest')
def staging_path(argument=4, prefix='.mailbox-backup-'):
    staging = pathlib.Path(sys.argv[argument])
    no_links(staging)
    if staging.parent != data or not re.fullmatch(re.escape(prefix) + '[0-9a-f]{32}', staging.name):
        fail('Foreign staging path refused')
    return staging
def publication_path(name):
    pending = backup / name
    if pathlib.PurePosixPath(name).name != name or not re.fullmatch(re.escape(PUBLISH_PREFIX) + BACKUP_NAME, name) or pending.is_symlink() or not pending.is_dir():
        fail('Invalid publication directory')
    return pending
def archive_record(staging):
    record = json.loads((staging / 'archive.json').read_text())
    if not re.fullmatch('[0-9a-f]{64}', record.get('sha256', '')) or not isinstance(record.get('bytes'), int):
        fail('Invalid local archive record')
    return record
def snapshot_manifest(source):
    path = source / 'manifest.json'
    if path.is_symlink() or path.stat().st_size > 16384:
        fail('Invalid backup manifest')
    manifest = json.loads(path.read_text())
    if manifest.get('format') != 4 or set(manifest.get('sha256', {})) != {SNAPSHOT_ARCHIVE} or set(manifest.get('trees', {})) != set(SNAPSHOT_ROOTS):
        fail('Unsupported backup manifest')
    return manifest
def removable(candidate, files, trees=()):
    if candidate.is_symlink() or not candidate.is_dir():
        return False
    for child in candidate.iterdir():
        if child.is_symlink() or not ((child.name in files and child.is_file()) or (child.name in trees and child.is_dir())):
            return False
    return True
def remove(candidate):
    for child in candidate.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    candidate.rmdir()
def cleanup_partials():
    # Only directories this job creates, with only names it writes. Never a dated backup with a manifest.
    for candidate in data.iterdir():
        if re.fullmatch(r'\.mailbox-backup-[0-9a-f]{32}', candidate.name) and removable(candidate, STAGING_FILES, SNAPSHOT_ROOTS):
            remove(candidate)
        elif re.fullmatch(r'\.rk-backup-mem-[0-9]{8}\.log', candidate.name) and regular(candidate):
            candidate.unlink()
    for candidate in backup.iterdir():
        hidden = re.fullmatch(re.escape(PUBLISH_PREFIX) + BACKUP_NAME, candidate.name)
        legacy = re.fullmatch(BACKUP_NAME, candidate.name) and not (candidate / 'manifest.json').exists() and not (candidate / 'manifest.json').is_symlink()
        if (hidden or legacy) and removable(candidate, PUBLISH_FILES):
            remove(candidate)
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
def secured_member(member, destination):
    safe = tarfile.data_filter(member, destination)
    return safe.replace(mode=0o700 if safe.isdir() else 0o600)
no_links(data)
if operation not in {'snapshot', 'arm', 'disarm', 'pack', 'cgroup', 'snapshot-restore'}:
    mounted_share()
if operation == 'preflight':
    trees = {name: tree_stats(data / name, key_names=name == 'celld') for name in SNAPSHOT_ROOTS}
    # Staging copy plus compressed archive must fit before anything stops.
    if shutil.disk_usage(data).free < 3 * sum(tree['bytes'] for tree in trees.values()):
        fail('Not enough local space for a staging snapshot')
    print('BACKUP_PREFLIGHT_PASSED ' + json.dumps(trees, sort_keys=True))
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
    signal.signal(signal.SIGALRM, lambda *_: fail('Snapshot copy exceeded its stop budget'))
    signal.alarm(SNAPSHOT_BUDGET)
    inactive(store_stopped=True)
    staging = staging_path()
    trees = {}
    for name in SNAPSHOT_ROOTS:
        trees[name] = tree_stats(data / name, key_names=name == 'celld')
        copy_tree(data / name, staging / name)
        if tree_stats(staging / name) != trees[name]:
            fail('Snapshot copy does not match source file count and bytes')
    write_synced(staging / 'snapshot.json', trees)
    signal.alarm(0)
    print('BACKUP_SNAPSHOT_VERIFIED ' + json.dumps(trees, sort_keys=True))
elif operation == 'cgroup':
    report = {}
    try:
        with open('/proc/self/cgroup') as stream:
            relative = next(line.split('::', 1)[1].strip() for line in stream if line.startswith('0::'))
        root = pathlib.Path('/sys/fs/cgroup') / relative.lstrip('/')
        for name in ['memory.events', 'memory.pressure', 'memory.current', 'memory.peak', 'memory.high']:
            if (root / name).is_file():
                report[name] = ' '.join((root / name).read_text().split())
        if (root / 'memory.stat').is_file():
            fields = dict(line.split(' ', 1) for line in (root / 'memory.stat').read_text().splitlines())
            report['memory.stat'] = {key: int(fields[key]) for key in ['anon', 'file', 'file_dirty', 'file_writeback'] if key in fields}
    except (OSError, StopIteration):
        report['unavailable'] = True
    print(json.dumps(report, sort_keys=True))
elif operation == 'pack':
    staging = staging_path()
    trees = json.loads((staging / 'snapshot.json').read_text())
    target = staging / SNAPSHOT_ARCHIVE
    h = hashlib.sha256()
    with target.open('xb') as raw:
        writer = CacheWriter(raw, digest=h)
        with gzip.GzipFile(filename='', fileobj=writer, mode='wb', compresslevel=1, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for name in SNAPSHOT_ROOTS:
                    add_tree(archive, staging / name, name)
        writer.sync()
    os.chmod(target, 0o600)
    size = target.stat().st_size
    write_synced(staging / 'archive.json', {'bytes': size, 'sha256': h.hexdigest(), 'trees': trees})
    print(str(size))
elif operation == 'share-open':
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    pending = backup / (PUBLISH_PREFIX + stamp + '-' + uuid.uuid4().hex)
    pending.mkdir(mode=0o700)
    print(pending.name)
elif operation == 'share-copy':
    staging, pending = staging_path(), publication_path(sys.argv[5])
    record = archive_record(staging)
    with (staging / SNAPSHOT_ARCHIVE).open('rb') as src, (pending / SNAPSHOT_ARCHIVE).open('xb') as dst:
        copied = cache_copy(src, dst, window=PUBLISH_WINDOW)
    if copied != record['sha256']:
        fail('Published stream checksum mismatch')
    print('BACKUP_SHARE_COPIED')
elif operation == 'share-manifest':
    staging, pending = staging_path(), publication_path(sys.argv[5])
    record = archive_record(staging)
    manifest = {'format': 4, 'createdAt': pending.name[len(PUBLISH_PREFIX):].split('-')[0], 'version': sys.argv[6], 'commit': sys.argv[7], 'sha256': {SNAPSHOT_ARCHIVE: record['sha256']}, 'bytes': {SNAPSHOT_ARCHIVE: record['bytes']}, 'trees': record['trees']}
    write_synced(pending / 'manifest.pending', manifest)
    (pending / 'manifest.pending').rename(pending / 'manifest.json')
    sync_directory(pending)
    print('BACKUP_SHARE_MANIFEST')
elif operation == 'share-commit':
    pending = publication_path(sys.argv[4])
    target = backup / pending.name[len(PUBLISH_PREFIX):]
    if target.exists() or target.is_symlink():
        fail('Refusing occupied publication name')
    pending.rename(target)
    sync_directory(backup)
    print(target.name)
elif operation in ['share-verify', 'cleanup']:
    staging = staging_path()
    source = backup / sys.argv[5]
    if pathlib.PurePosixPath(sys.argv[5]).name != sys.argv[5] or not complete_backup(source, snapshot_backup):
        fail('Published backup is not complete')
    record, manifest = archive_record(staging), snapshot_manifest(source)
    if manifest['sha256'][SNAPSHOT_ARCHIVE] != record['sha256'] or manifest['bytes'][SNAPSHOT_ARCHIVE] != record['bytes']:
        fail('Published manifest does not match the local archive')
    if operation == 'share-verify':
        # A real read back over the share, not the write-stream hash.
        if (source / SNAPSHOT_ARCHIVE).stat().st_size != record['bytes'] or digest(source / SNAPSHOT_ARCHIVE) != record['sha256']:
            fail('Published archive readback mismatch')
        print('BACKUP_SHARE_VERIFIED')
    else:
        cleanup_partials()
        print('BACKUP_CLEANED')
elif operation == 'snapshot-fetch':
    # Copy and validate before anything stops, so the outage covers only the swap.
    candidates = sorted([path for path in backup.iterdir() if complete_backup(path, snapshot_backup)], reverse=True)
    if len(sys.argv) > 4:
        candidates = [path for path in candidates if path.name == sys.argv[4]]
    if not candidates:
        fail('No complete snapshot backup')
    source = candidates[0]
    no_links(source)
    manifest = snapshot_manifest(source)
    local = data / ('.mailbox-restore-' + uuid.uuid4().hex)
    local.mkdir(mode=0o700)
    with (source / SNAPSHOT_ARCHIVE).open('rb') as src, (local / SNAPSHOT_ARCHIVE).open('xb') as dst:
        if cache_copy(src, dst) != manifest['sha256'][SNAPSHOT_ARCHIVE]:
            fail('Restore checksum mismatch')
    snapshot_members(local / SNAPSHOT_ARCHIVE, manifest['trees'])
    write_synced(local / 'manifest.json', manifest)
    print(str(local) + ' ' + source.name)
elif operation == 'snapshot-restore':
    inactive(restoring=True, store_stopped=True)
    local = staging_path(prefix='.mailbox-restore-')
    manifest = json.loads((local / 'manifest.json').read_text())
    if digest(local / SNAPSHOT_ARCHIVE) != manifest['sha256'][SNAPSHOT_ARCHIVE]:
        fail('Restore checksum mismatch')
    aside = data / ('.mailbox-restore-aside-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex)
    aside.mkdir(mode=0o700)
    moved = []
    try:
        for name in SNAPSHOT_ROOTS:
            if (data / name).is_symlink():
                fail('Symlink data directory refused')
            if (data / name).exists():
                (data / name).rename(aside / name)
                moved.append(name)
        with cache_tar(local / SNAPSHOT_ARCHIVE) as archive:
            for member in archive:
                if pathlib.PurePosixPath(member.name).parts[0] not in SNAPSHOT_ROOTS:
                    fail('Unsafe snapshot member refused')
                archive.extract(member, data, filter=secured_member)
                archive.members.clear()
        for name in SNAPSHOT_ROOTS:
            # Never rely on the operator's umask.
            os.chmod(data / name, 0o700)
            if tree_stats(data / name) != manifest['trees'][name]:
                fail('Restored data does not match the snapshot manifest')
    except BaseException:
        # Keep every byte: partial extraction goes aside, the previous data comes back.
        for name in SNAPSHOT_ROOTS:
            if (data / name).exists() and not (data / name).is_symlink():
                (data / name).rename(aside / ('partial-' + name))
        for name in moved:
            (aside / name).rename(data / name)
        raise
    (local / SNAPSHOT_ARCHIVE).unlink()
    (local / 'manifest.json').unlink()
    local.rmdir()
    print('BACKUP_SNAPSHOT_RESTORED ' + aside.name)
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
    newest = sorted([path for path in backup.iterdir() if complete_backup(path)], reverse=True)
    if newest and not legacy_backup(newest[0]):
        fail('Newest backup is a filesystem snapshot; use restore-snapshot')
    candidates = sorted([path for path in backup.iterdir() if complete_backup(path, legacy_backup)], reverse=True)
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
    with cache_tar(source / celld_name) as archive:
        for member in archive:
            archive.extract(member, data, filter=secured_member)
            archive.members.clear()
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
