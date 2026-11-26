#!/usr/bin/env python3
"""Project a verified, offline Mailbox SQLite export. Never contacts celld."""

import argparse
import contextlib
import hashlib
import json
import sqlite3
from pathlib import Path


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def project(path, observed_at):
    require(not any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')),
            'Use a cold, checkpointed SQLite export')
    with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity check failed')
        names = db.execute('SELECT actor_name FROM _cf_METADATA').fetchall()
        require(len(names) == 1 and isinstance(names[0][0], str) and names[0][0].startswith('did:web:'),
                'Expected one named Mailbox actor')
        did = names[0][0]
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'lease', 'metadata'} <= tables:
            # A runtime-only database does not prove standing.
            return None
        meta = dict(db.execute("SELECT key,value FROM metadata WHERE key IN ('recipient','retirement','didDocument')"))
        require(meta.get('recipient') == did, 'Mailbox identity differs from the actor name')
        lease_row = db.execute('SELECT value FROM lease WHERE singleton=1').fetchone()
        lease = {} if lease_row is None else json.loads(lease_row[0])
        require(lease.get('did', did) == did, 'Lease identity differs from the actor name')
        revision = db.execute('SELECT version,observed_at FROM name_revision WHERE singleton=1').fetchone() if 'name_revision' in tables else None
        version, at = (0, observed_at) if revision is None else revision
        row = {'state': {'did': did, 'leaseExpiresAt': lease.get('expiresAt', 0),
                         'leaseGeneration': lease.get('generation', 0), 'observedAt': at,
                         'retirement': json.loads(meta.get('retirement', 'null')), 'version': version}}
        if 'didDocument' in meta:
            doc = json.loads(meta['didDocument'])
            require(doc.get('id') == did, 'Document identity differs from the actor name')
            # Publish only public fields; older stored documents may contain extra keys.
            row['document'] = {
                'id': did,
                'authentication': doc['authentication'],
                'keyAgreement': doc['keyAgreement'],
                'verificationMethod': [
                    {'id': method['id'], 'controller': method['controller'],
                     'publicKeyJwk': {key: method['publicKeyJwk'][key] for key in ('crv', 'kty', 'x', 'y')}}
                    for method in doc['verificationMethod']
                ],
            }
        return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True, help='Manifest hash from the verified export receipt')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    require(digest(args.manifest) == args.sha256, 'Manifest digest differs from the verified receipt')
    manifest = json.loads(args.manifest.read_bytes())
    base = args.manifest.resolve().parent
    at = manifest['observedAt']
    require(type(at) is int and at > 0 and isinstance(manifest['mailboxes'], list), 'Invalid export manifest')
    rows = {}
    for entry in manifest['mailboxes']:
        path = (base / entry['file']).resolve(strict=True)
        require(path.is_relative_to(base), 'Cold export path escapes manifest directory')
        require(digest(path) == entry['sha256'], 'Cold database digest mismatch')
        row = project(path, at)
        if row is not None:
            did = row['state']['did']
            require(did not in rows, 'Duplicate Mailbox actor in the verified export')
            rows[did] = row
    require(rows, 'Verified export contains no Mailbox standing')
    with args.out.open('x', encoding='utf-8') as file:
        json.dump([rows[key] for key in sorted(rows)], file, separators=(',', ':'))
        file.write('\n')
    print(f'{len(rows)} rows; sha256 {digest(args.out)}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, KeyError, TypeError, ValueError, sqlite3.Error) as error:
        raise SystemExit(f'Seed export refused: {error}') from None
