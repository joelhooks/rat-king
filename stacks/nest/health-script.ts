export const healthScript = String.raw`
import json, os, pathlib, re, sys, urllib.request
BACKUP_NAME = r'[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{32}'
ARCHIVES = {4: ['mailbox.tar.gz'], 3: ['objects.tar.gz', 'celld.tar.gz'], 2: ['objects.tar', 'celld.tar']}
def regular(path):
    return path.is_file() and not path.is_symlink()
def volumes(collection):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:19333/vol/status', timeout=15) as response:
        body = response.read(32 * 1024 * 1024 + 1)
    if len(body) > 32 * 1024 * 1024:
        raise RuntimeError('volume status too large')
    totals = {'fileCount': 0, 'deleteCount': 0, 'bytes': 0, 'volumes': 0}
    for center in json.loads(body)['Volumes']['DataCenters'].values():
        for rack in center.values():
            for node in rack.values():
                for volume in node or []:
                    if volume['Collection'] == collection:
                        totals['fileCount'] += volume['FileCount']
                        totals['deleteCount'] += volume['DeleteCount']
                        totals['bytes'] += volume['Size']
                        totals['volumes'] += 1
    return totals
def newest(root):
    for path in sorted(pathlib.Path(root).iterdir(), key=lambda entry: entry.name, reverse=True):
        manifest = path / 'manifest.json'
        if not re.fullmatch(BACKUP_NAME, path.name) or path.is_symlink() or not path.is_dir() or not regular(manifest) or manifest.stat().st_size > 16384:
            continue
        form = json.loads(manifest.read_text()).get('format')
        archives = [path / name for name in ARCHIVES.get(form, [])]
        if archives and all(regular(archive) for archive in archives):
            return {'name': path.name, 'format': form, 'archiveBytes': sum(archive.stat().st_size for archive in archives)}
    return None
operation = sys.argv[1]
if operation == 'volumes':
    print(json.dumps(volumes(sys.argv[2])))
elif operation == 'share':
    print(json.dumps({'newest': newest(sys.argv[2])}))
else:
    raise RuntimeError('expected volumes or share')
`;
