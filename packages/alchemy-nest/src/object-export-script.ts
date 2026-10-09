export const objectExportScript = String.raw`
def collect_export(target, strict=False):
    import sqlite3
    catalog = pathlib.Path(str(target) + '.sqlite')
    spool = pathlib.Path(str(target) + '.data')
    with sqlite3.connect(catalog) as db, spool.open('ab') as output:
        db.execute('PRAGMA cache_size=-2048')
        db.execute('CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, etag TEXT, offset INTEGER, size INTEGER, sha256 TEXT, generation TEXT)')
        generation = uuid.uuid4().hex
        token, previous_key = '', ''
        while True:
            parameters = {'list-type': '2', 'max-keys': '1000'}
            if token:
                parameters['continuation-token'] = token
            query = urllib.parse.urlencode(sorted(parameters.items()), quote_via=urllib.parse.quote, safe='~')
            status, body = request('GET', query=query)
            if status != 200:
                raise RuntimeError('Backup bucket listing failed')
            page = ET.fromstring(body)
            for item in page.findall('./{*}Contents'):
                key, etag = item.findtext('./{*}Key', ''), item.findtext('./{*}ETag', '')
                # Seaweed's pinned listing is lexical. Fail closed on duplicates/cursor cycles.
                if key <= previous_key:
                    raise RuntimeError('Non-monotonic export listing')
                previous_key = key
                if key == 'fleet/peer-auth.json':
                    continue
                require_safe_key(key)
                if not etag:
                    raise RuntimeError('Backup requires listing ETags')
                old = db.execute('SELECT etag FROM objects WHERE key=?', (key,)).fetchone()
                if old and old[0] == etag:
                    db.execute('UPDATE objects SET generation=? WHERE key=?', (generation, key))
                    continue
                offset = output.tell()
                code, result = request('GET', key, sink=output)
                if code == 404 and not strict:
                    continue
                if code != 200:
                    raise RuntimeError('Backup object read failed')
                size, digest, fetched_etag = result
                if not fetched_etag or (strict and fetched_etag != etag):
                    raise RuntimeError('Object changed during final delta')
                db.execute('INSERT OR REPLACE INTO objects VALUES (?,?,?,?,?,?)', (key, fetched_etag, offset, size, digest, generation))
            db.commit()
            if page.findtext('./{*}IsTruncated', 'false') != 'true':
                break
            next_cursor = page.findtext('./{*}NextContinuationToken', '')
            if not next_cursor or next_cursor == token:
                raise RuntimeError('Invalid backup listing cursor')
            token = next_cursor
        db.execute('DELETE FROM objects WHERE generation != ?', (generation,))
        db.commit()
        output.flush()
        os.fsync(output.fileno())
    print('LOGICAL_OBJECT_COLLECTION_PASSED')

def pack_export(target):
    import sqlite3
    with sqlite3.connect(str(target) + '.sqlite') as db, pathlib.Path(str(target) + '.data').open('rb') as spool, target.open('xb') as destination, tarfile.open(fileobj=destination, mode='w|') as archive:
        db.execute('PRAGMA cache_size=-2048')
        def metadata(name, value):
            value = json.dumps(value).encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(value), 0o600
            archive.addfile(info, io.BytesIO(value))
            archive.members.clear()
        metadata('format.json', {'format': 2})
        count = 0
        for key, offset, size, digest in db.execute('SELECT key, offset, size, sha256 FROM objects ORDER BY key'):
            require_safe_key(key)
            member = object_member(key)
            metadata('entry.json', {'key': key, 'member': member, 'sha256': digest})
            info = tarfile.TarInfo(member)
            info.size, info.mode = size, 0o600
            spool.seek(offset)
            archive.addfile(info, spool)
            archive.members.clear()
            count += 1
    print('LOGICAL_OBJECT_EXPORT_PASSED ' + str(count))
`;
