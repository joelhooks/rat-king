export const backupRetentionScript = String.raw`
import datetime, json, os, pathlib, re, stat

RETENTION_NAME = r'[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{32}'
RETENTION_FILES = {2: {'objects.tar', 'celld.tar'}, 3: {'objects.tar.gz', 'celld.tar.gz'}, 4: {'mailbox.tar.gz'}}

def retention_keep(names):
    ordered = sorted(set(names))
    if not ordered:
        return set()
    weeks = {}
    for name in ordered:
        date = datetime.datetime.strptime(name.split('-')[0], '%Y%m%dT%H%M%S.%fZ')
        weeks[date.isocalendar()[:2]] = name
    return set(ordered[-7:]) | {weeks[week] for week in sorted(weeks)[-4:]} | {ordered[0]}

def retention_path(root, candidate=None):
    for path in [root] if candidate is None else [root, candidate]:
        if not path.is_absolute() or '..' in path.parts or path.resolve() != path or any(part.is_symlink() for part in [path, *path.parents]):
            raise RuntimeError('BACKUP_RETENTION_ALARM: noncanonical path can escape the mailbox backup root')
    if candidate is not None and (candidate.parent != root or not candidate.is_dir()):
        raise RuntimeError('BACKUP_RETENTION_ALARM: deletion must name a directory directly under the mailbox backup root')

def retention_bytes(path):
    if not path.is_dir() or path.is_symlink():
        return path.lstat().st_size if stat.S_ISREG(path.lstat().st_mode) else 0
    size = 0
    for directory, _, files in os.walk(path, followlinks=False):
        for name in files:
            info = (pathlib.Path(directory) / name).lstat()
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
    return size

def retention_published(path):
    # The publication marker is manifest.json. Unknown/malformed markers are never authority to delete.
    try:
        if not re.fullmatch(RETENTION_NAME, path.name) or path.is_symlink() or not path.is_dir():
            return False
        datetime.datetime.strptime(path.name.split('-')[0], '%Y%m%dT%H%M%S.%fZ')
        marker = path / 'manifest.json'
        if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 16384:
            return False
        record = json.loads(marker.read_text())
        if not isinstance(record, dict) or type(record.get('format')) is not int:
            return False
        files = RETENTION_FILES.get(record['format'])
        hashes = record.get('sha256')
        if files is None or not isinstance(hashes, dict) or set(hashes) != files:
            return False
        for name in files:
            file = path / name
            if not isinstance(hashes[name], str) or not re.fullmatch('[0-9a-f]{64}', hashes[name]) or file.is_symlink() or not file.is_file():
                return False
        # Refuse foreign files, child directories and links, not just unknown manifests.
        return all(child.name in files | {'manifest.json'} and not child.is_symlink() and child.is_file() for child in path.iterdir())
    except (OSError, ValueError, TypeError):
        return False

def retention_alarm(reason, kept, would_remove):
    print('BACKUP_RETENTION_ALARM reason=' + reason + ' kept=' + str(kept) + ' wouldRemove=' + str(would_remove), flush=True)

def retention_apply(root, confirmed, dry_run, report):
    retention_path(root)
    if not re.fullmatch(RETENTION_NAME, confirmed) or not retention_published(root / confirmed):
        retention_alarm('unconfirmed', 0, 0)
        return
    paths = sorted(root.iterdir(), key=lambda path: path.name)
    report['kept'] = len(paths)
    sizes = {path.name: retention_bytes(path) for path in paths}
    report['entries'] = sizes
    published = [path.name for path in paths if retention_published(path)]
    unknown = {path.name for path in paths} - set(published)
    keep = retention_keep(published)
    proposed = [name for name in published if name not in keep]
    reason = None
    if unknown:
        reason = 'unknown-publication'
    elif len(proposed) > 3:
        reason = 'removal-limit'
    would_remove = len(proposed)
    report['wouldRemove'] = would_remove
    if len(published) < 8 or reason is not None:
        proposed = []
    for path in paths:
        if path.name not in proposed:
            print('BACKUP_RETENTION_KEPT ' + path.name + ' ' + str(sizes[path.name]), flush=True)
            report['reported'].add(path.name)
    if reason is not None:
        retention_alarm(reason, len(paths), would_remove)
        return
    # Validate the entire deletion plan before the first unlink. Revalidate each target at use.
    newest = max(published)
    for name in proposed:
        retention_path(root, root / name)
        if name == newest or not retention_published(root / name):
            raise RuntimeError('BACKUP_RETENTION_ALARM: newest or unrecognized backup in deletion plan; refusing loss of a good copy')
    for name in proposed:
        path = root / name
        retention_path(root, path)
        if not retention_published(path):
            raise RuntimeError('BACKUP_RETENTION_ALARM: publication changed; refusing deletion')
        if not dry_run:
            # All children were checked as regular files; no recursive traversal or link following.
            for child in path.iterdir():
                child.unlink()
            path.rmdir()
            report['kept'] -= 1
        print(('BACKUP_RETENTION_WOULD_REMOVE ' if dry_run else 'BACKUP_RETENTION_REMOVED ') + name + ' ' + str(sizes[name]), flush=True)
        report['reported'].add(name)

def retention_run(root, confirmed, dry_run=False):
    report = {'kept': 0, 'wouldRemove': 0, 'entries': {}, 'reported': set()}
    try:
        retention_apply(root, confirmed, dry_run, report)
    except Exception:
        # Errors never turn a confirmed backup into a failed backup. Never print exception contents.
        for name, size in report['entries'].items():
            if name not in report['reported']:
                print('BACKUP_RETENTION_KEPT ' + name + ' ' + str(size), flush=True)
        retention_alarm('error', report['kept'], report['wouldRemove'])
`;
