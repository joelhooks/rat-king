export const objectArchiveScript = String.raw`
def forbidden_key(key):
    name = pathlib.PurePosixPath(key).name.lower()
    return name in {'peer-auth.json', 's3.json', 's3.config', 'celld.env', 'credentials', 'credentials.json', '.env', '.dev.vars'} or name.endswith(('.jwk', '.pem', '.key'))

def require_safe_key(key):
    if not isinstance(key, str) or not key or key.startswith('/') or '..' in key.split('/') or forbidden_key(key):
        raise RuntimeError('Backup refuses known credential/key object pattern')

def validate_export(archive):
    member = archive.getmember('index.json')
    if not member.isfile() or member.size > 16 * 1024 * 1024:
        raise RuntimeError('Invalid object index')
    metadata = archive.extractfile(member)
    index = json.load(metadata)
    if index.get('format') != 1 or not isinstance(index.get('objects'), list):
        raise RuntimeError('Unsupported object export')
    seen = set()
    for entry in index['objects']:
        key, member = entry['key'], entry['member']
        require_safe_key(key)
        if key in seen or member != 'objects/' + hashlib.sha256(key.encode()).hexdigest() + '.blob':
            raise RuntimeError('Invalid object export member')
        seen.add(key)
        info = archive.getmember(member)
        if not info.isfile():
            raise RuntimeError('Special object member refused')
        stream = archive.extractfile(info)
        h = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
        if h.hexdigest() != entry['sha256']:
            raise RuntimeError('Object export checksum mismatch')
    expected = {'index.json', *(entry['member'] for entry in index['objects'])}
    members = archive.getmembers()
    if len(members) != len(expected) or {member.name for member in members} != expected or any(not member.isfile() for member in members):
        raise RuntimeError('Unexpected object export member')
    return index
`;
