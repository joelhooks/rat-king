import { objectArchiveScript } from "../../packages/alchemy-nest/src/object-archive-script.ts";

export const backupScript = String.raw`
import datetime, hashlib, json, os, pathlib, shutil, stat, subprocess, sys, tarfile, uuid
operation, data_arg, backup_arg = sys.argv[1:4]
data, backup = pathlib.Path(data_arg), pathlib.Path(backup_arg)
${objectArchiveScript}
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
def inactive(restoring=False):
    units = ['rat-king-celld.service', 'rat-king-seaweedfs.service'] if restoring else ['rat-king-celld.service']
    for unit in units:
        result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState,Result'], capture_output=True, text=True, check=True)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if fields.get('ActiveState') not in ['inactive', 'failed']:
            fail('Snapshot/restore requires its writers stopped')
        if not restoring and (fields.get('ActiveState') != 'inactive' or fields.get('Result') != 'success'):
            fail('Backup refuses a failed or timed-out shutdown')
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
def sync_file(path):
    with path.open('rb') as stream:
        os.fsync(stream.fileno())
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
    seen = set()
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'celld' or not (member.isdir() or member.isfile()) or member.name in seen:
            fail('Unsafe celld snapshot member refused')
        require_safe_key(member.name)
        seen.add(member.name)
no_links(data)
mounted_share()
if operation == 'preflight':
    checked_tree(data / 'celld')
    print('BACKUP_PREFLIGHT_PASSED')
elif operation == 'stage':
    inactive()
    staging = data / ('.mailbox-backup-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    print(str(staging))
elif operation == 'snapshot':
    inactive()
    staging = staging_path()
    checked_tree(data / 'celld')
    target = staging / 'celld.tar'
    with tarfile.open(target, 'x') as archive:
        archive.add(data / 'celld', arcname='celld', recursive=True)
    for name in ['objects.tar', 'celld.tar']:
        sync_file(staging / name)
        os.chmod(staging / name, 0o600)
    with tarfile.open(staging / 'objects.tar') as archive:
        validate_export(archive)
    print('SNAPSHOT_KEY_PATTERN_ASSERTION_PASSED')
elif operation == 'publish':
    staging = staging_path()
    with tarfile.open(staging / 'objects.tar') as archive:
        validate_export(archive)
    with tarfile.open(staging / 'celld.tar') as archive:
        validate_celld(archive)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    target = backup / (stamp + '-' + uuid.uuid4().hex)
    target.mkdir()
    hashes = {}
    for name in ['objects.tar', 'celld.tar']:
        source, destination = staging / name, target / name
        if not source.is_file() or source.is_symlink():
            fail('Invalid snapshot archive')
        expected = digest(source)
        with source.open('rb') as src, destination.open('xb') as dst:
            shutil.copyfileobj(src, dst, length=1024 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
        if digest(destination) != expected:
            fail('Published archive checksum mismatch')
        hashes[name] = expected
    manifest = {'format': 2, 'createdAt': stamp, 'version': sys.argv[5], 'commit': sys.argv[6], 'sha256': hashes}
    with (target / 'manifest.pending').open('x') as stream:
        json.dump(manifest, stream)
        stream.flush()
        os.fsync(stream.fileno())
    (target / 'manifest.pending').rename(target / 'manifest.json')
    for name in ['objects.tar', 'celld.tar']:
        (staging / name).unlink()
    staging.rmdir()
    print('BACKUP_PUBLISHED ' + target.name)
elif operation == 'restore':
    inactive(restoring=True)
    if data.exists() and any(data.iterdir()):
        fail('Restore requires a fresh empty data root; existing data is preserved')
    candidates = sorted([path for path in backup.iterdir() if path.is_dir() and not path.is_symlink() and (path / 'manifest.json').is_file()], reverse=True)
    if not candidates:
        fail('No complete backup')
    source = candidates[0]
    no_links(source)
    manifest_path = source / 'manifest.json'
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 16384:
        fail('Invalid backup manifest')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('format') != 2 or set(manifest.get('sha256', {})) != {'objects.tar', 'celld.tar'}:
        fail('Unsupported backup manifest')
    for name in ['objects.tar', 'celld.tar']:
        archive_path = source / name
        if archive_path.is_symlink() or digest(archive_path) != manifest['sha256'][name]:
            fail('Restore checksum mismatch')
    with tarfile.open(source / 'objects.tar') as archive:
        validate_export(archive)
    with tarfile.open(source / 'celld.tar') as archive:
        validate_celld(archive)
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(data, 0o700)
    with tarfile.open(source / 'celld.tar') as archive:
        archive.extractall(data, filter='data')
    target = data / '.mailbox-restore-objects.tar'
    with (source / 'objects.tar').open('rb') as src, target.open('xb') as dst:
        shutil.copyfileobj(src, dst, length=1024 * 1024)
        dst.flush()
        os.fsync(dst.fileno())
    os.chmod(target, 0o600)
    print('BACKUP_RESTORED ' + source.name)
else:
    fail('Unknown backup action')
`;
