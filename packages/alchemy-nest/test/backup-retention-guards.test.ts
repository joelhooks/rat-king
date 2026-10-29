import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { backupScript } from "../../../stacks/nest/backup-script.ts";
import { localExec } from "../src/local-exec.ts";
import { beforePrune, currentIndices } from "./backup-retention-fixture.ts";

const fixture = String.raw`
import contextlib, io, json, pathlib, subprocess, sys, tempfile
script, rows_arg, current_arg, fault = sys.argv[1:5]
rows = [(name, int(size)) for name, size in (line.split() for line in rows_arg.splitlines())]
current = [rows[index] for index in json.loads(current_arg)]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp).resolve()
    data, backup, outside = root/'data', root/'backup', root/'outside'
    data.mkdir(); backup.mkdir(); outside.mkdir()
    (outside/'keep').write_bytes(b'outside')
    subprocess.run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, str(backup)+'\n', '')
    inject_error = False
    def run(confirmed, dry=False):
        sys.argv = ['backup', 'retention', str(data), str(backup), confirmed]
        out = io.StringIO()
        injected = script.replace('retention_run(backup, sys.argv[4])', 'retention_run(backup, sys.argv[4], dry_run=True)') if dry else script
        if inject_error:
            injected = injected.replace('keep = retention_keep(published)', "raise OSError('invented-private-error')")
        with contextlib.redirect_stdout(out):
            try:
                exec(injected, {})
                code = 0
            except SystemExit as error:
                code = error.code
        return code, out.getvalue()
    def publish(name, size, format=4):
        path = backup/name
        path.mkdir()
        files = {2: ['objects.tar', 'celld.tar'], 3: ['objects.tar.gz', 'celld.tar.gz'], 4: ['mailbox.tar.gz']}[format]
        (path/'manifest.json').write_text(json.dumps({'format': format, 'sha256': {name: 'a'*64 for name in files}}))
        for file in files: (path/file).touch()
        # Sparse files prove exact byte logging against the listing without copying archives.
        with (path/files[0]).open('r+b') as stream:
            stream.truncate(size - (path/'manifest.json').stat().st_size)
    # Historical 22→10 is the rule's oracle. The automatic cap must refuse the 12 removals.
    for index, (name, size) in enumerate(rows): publish(name, size, 2 if index == 0 else 4)
    namespace = {}
    # Load only declarations from the rendered script; this does not run a backup operation.
    exec(script.split('no_links(data)\nif operation')[0], namespace)
    assert namespace['retention_keep']([name for name, _ in rows]) == {name for name, _ in current}
    code, output = run(rows[-1][0], dry=True)
    assert code == 0 and 'BACKUP_RETENTION_ALARM reason=removal-limit kept=22 wouldRemove=12' in output and 'REMOVED ' not in output and 'WOULD_REMOVE ' not in output, output
    assert len(list(backup.iterdir())) == 22
    assert all('BACKUP_RETENTION_KEPT ' + name + ' ' + str(size) in output for name, size in rows), output
    # Reduce only the disposable fixture to the current listing. Production is never touched.
    for name, _ in rows:
        if name not in {name for name, _ in current}:
            for child in (backup/name).iterdir(): child.unlink()
            (backup/name).rmdir()
    next_name = '20261029T100000.000000Z-' + 'f'*32
    publish(next_name, 4096, 3 if fault == 'format3' else 4)
    dropped, dropped_size = current[3]
    assert dropped.startswith('20261022')
    # Dry-run describes the one removal and leaves every byte intact.
    code, output = run(next_name, dry=True)
    assert code == 0 and 'BACKUP_RETENTION_WOULD_REMOVE ' + dropped + ' ' + str(dropped_size) in output, output
    assert len(list(backup.iterdir())) == 11
    inject_error = fault == 'exception'
    marker = backup/dropped/'manifest.json'
    if fault == 'missing': marker.unlink()
    elif fault == 'malformed': marker.write_text('{broken')
    elif fault == 'unknown-format': marker.write_text(json.dumps({'format': 99, 'sha256': {'mailbox.tar.gz': 'a'*64}}))
    elif fault == 'missing-archive': (backup/dropped/'mailbox.tar.gz').unlink()
    elif fault == 'empty-hashes': marker.write_text(json.dumps({'format': 4, 'sha256': {}}))
    elif fault == 'unsafe-hash-name': marker.write_text(json.dumps({'format': 4, 'sha256': {'../../outside/keep': 'a'*64}}))
    elif fault == 'marker-link': marker.unlink(); marker.symlink_to(outside/'keep')
    elif fault == 'child-link': (backup/dropped/'foreign').symlink_to(outside, target_is_directory=True)
    elif fault == 'directory-link':
        (backup/dropped).rename(root/'saved')
        (backup/dropped).symlink_to(outside, target_is_directory=True)
    elif fault == 'unknown-directory': (backup/'user-work').mkdir()
    elif fault == 'foreign-file': (backup/'user-file').write_bytes(b'preserve')
    elif fault == 'unconfirmed':
        code, output = run('20261030T100000.000000Z-'+'a'*32)
        assert code == 0 and 'BACKUP_RETENTION_ALARM reason=unconfirmed' in output
        assert len(list(backup.iterdir())) == 11
    elif fault == 'traversal':
        code, output = run('../outside')
        assert code == 0 and 'BACKUP_RETENTION_ALARM reason=unconfirmed' in output
    invalid = fault not in ['none', 'format3', 'unconfirmed', 'traversal', 'root-link']
    if fault == 'root-link':
        backup.rename(root/'saved')
        backup.symlink_to(root/'saved', target_is_directory=True)
        try: run(next_name)
        except RuntimeError as error: assert 'Symlink path refused' in str(error)
        else: raise AssertionError('Symlink root accepted')
        backup.unlink(); (root/'saved').rename(backup)
    before = sorted(path.name for path in backup.iterdir())
    code, output = run(next_name)
    if invalid:
        reason = 'error' if fault == 'exception' else 'unknown-publication'
        assert code == 0 and 'BACKUP_RETENTION_ALARM reason=' + reason in output, output
        assert 'invented-private-error' not in output
        assert sorted(path.name for path in backup.iterdir()) == before, output
        assert 'REMOVED ' not in output
    else:
        assert code == 0 and 'BACKUP_RETENTION_REMOVED ' + dropped + ' ' + str(dropped_size) in output, output
        assert sorted(path.name for path in backup.iterdir()) == sorted([name for name, _ in current if name != dropped] + [next_name])
        assert all('BACKUP_RETENTION_KEPT ' + name + ' ' + str(size) in output for name, size in current if name != dropped)
        assert (backup/next_name).is_dir()
        # A second confirmed run is idempotent.
        code, output = run(next_name)
        assert code == 0 and 'REMOVED ' not in output, output
    assert (outside/'keep').read_bytes() == b'outside'
    print('RETENTION_GUARDS_PASSED')
`;

it.effect.prop(
  "the real listing keeps exactly ten; post-publish pruning removes one with byte logs, while unsafe markers and paths alarm without deleting",
  {
    fault: Arbitrary.schema(
      Schema.Literals([
        "none",
        "format3",
        "missing",
        "malformed",
        "unknown-format",
        "missing-archive",
        "empty-hashes",
        "unsafe-hash-name",
        "marker-link",
        "child-link",
        "directory-link",
        "unknown-directory",
        "foreign-file",
        "unconfirmed",
        "traversal",
        "root-link",
        "exception",
      ])
    ),
  },
  ({ fault }) =>
    Effect.gen(function* retentionGuards() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        fixture,
        backupScript,
        beforePrune,
        JSON.stringify(currentIndices),
        fault,
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("RETENTION_GUARDS_PASSED");
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 50 } }
);
