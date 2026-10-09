# Mailbox backup design

## Why a filesystem snapshot

The previous backup exported the bucket through S3, one object at a time. The live store holds about 345,000 small objects. Four rounds of fixes each hit a new limit: page-cache OOM, a 30-minute timeout, the 15-second final-delta budget and a 2-hour publication hang. The data itself is small and local: `celld/` is about 53 MB and `seaweedfs/` about 1.3 GB, both on local NVMe. A stopped copy of both directories takes seconds, regardless of object count.

## Consistency and stop time

Before anything stops, the job checks the SMB mount, both units' health, and local free space (at least three times the data size). It walks both data directories, refusing symlinks and special files, and refuses known key filenames under `celld/`. It then creates a staging directory and arms a durable restart marker. Arming refuses a missing unit start timestamp or a unit age of 20 minutes or more, and checks the age again after the marker fsync. The stop now begins within seconds of unit start, well inside the host owner's 35-minute monitoring window.

The stopped window is:

1. Stop celld, then SeaweedFS. Both must report `inactive` with `Result=success`. A failed or timed-out shutdown refuses the copy.
2. Copy `seaweedfs/` and `celld/` into staging. Each file is a reflink (`FICLONE`) where the filesystem supports it, so no data is written. Otherwise the copy goes through the shared writer, which fsyncs and drops file cache every 8 MiB. Modes and timestamps are preserved.
3. Compare file count, directory count and total bytes of each copy with its source. A mismatch fails the backup.
4. Start SeaweedFS, then celld. Each `systemctl start` returns only after the unit's `ExecStartPost` health gate passes; the job then checks `is-active`. Celld starts exactly once on the success path.
5. Disarm the marker and log `BACKUP_STOP_MS`.

Copy and verification have a 20-second Python alarm and a 30-second outer bound. The target for the whole outage, including graceful stops and guarded starts, is well under 30 seconds. Only the live run can measure it.

SeaweedFS and celld are both stopped, so the copy is a consistent cut of everything they persist. This replaces the S3-level reconciliation. It does not depend on SeaweedFS listing semantics or object count.

## Recovery

Recovery covers the stopped window only. Any failure or interruption between the first stop and the disarm runs an uninterruptible recovery: start SeaweedFS, then celld, then disarm. The systemd `ExecStopPost` hook independently checks the marker after a worker error, timeout, OOM or SIGKILL, and starts both units in the same order. A failed start preserves the marker and fails the hook. The startup gate is never bypassed.

**2026-10-09 recovery failure.** The old runner wrapped publication inside the same `onError` as the stopped window. When `TimeoutStartSec` fired at 12:00:37Z, systemd sent SIGTERM to the whole unit cgroup. The interrupted runner then entered recovery even though celld had restarted hours earlier and the marker was already disarmed. The effect platform reports a child that exits by signal as `HostError {exec, "Local command failed"}`. That matches the logged `BACKUP_RECOVERY_FAILED`. Recovery never needed to run then. Now publication failures abandon the publication without touching a unit. The lifecycle machine has no `failed` transition outside the stopped window.

## Publication

Publication starts after both units are running.

1. **Pack:** a streaming gzip level 1 tar (PAX) of `seaweedfs/` and `celld/` in staging. SHA-256 is computed over the compressed bytes as they are written. The writer fsyncs and drops cache every 8 MiB.
2. **Local `gzip -t`** of the archive.
3. **Share open:** create the hidden `.mailbox-publish-<timestamp>-<hex>` directory.
4. **Share copy:** copy with 32 MiB windows, hashing the bytes written, then compare with the local hash.
5. **Share manifest:** write and fsync a format-4 manifest, rename it into place and sync the directory.
6. **Share commit:** rename the directory to its final dated name and sync the parent. The rename is the publication boundary. An occupied final name is refused.
7. **Share verify:** read the published archive back over the share and compare its size and SHA-256 with the local archive.
8. **Share `gzip -t`** on the published archive.
9. **Cleanup**, only after 7 and 8 pass.

Every step that can touch the share runs as its own process under its own Effect timeout: 60 seconds for metadata steps, and 120 seconds plus one second per MiB for whole-archive passes. A timed-out step fails the backup in minutes instead of consuming the 2-hour unit timeout. Interruption signals the child's process group and waits at most one second. A process stuck in uninterruptible CIFS I/O can outlive that wait, but the runner no longer waits for it. Pack has a 45-minute bound. The 2-hour `TimeoutStartSec` remains the last resort.

A failure before the commit rename leaves only a hidden directory, which is never a restore candidate. A failure after the rename (a verification mismatch) leaves a dated directory with a manifest. Cleanup preserves it for operator inspection, and the job reports failure.

### Format 4

A backup directory contains `mailbox.tar.gz` and `manifest.json`:

```json
{
  "format": 4,
  "createdAt": "<timestamp>",
  "version": "<version>",
  "commit": "<commit>",
  "sha256": { "mailbox.tar.gz": "<hex>" },
  "bytes": { "mailbox.tar.gz": 0 },
  "trees": {
    "celld": { "files": 0, "directories": 0, "bytes": 0 },
    "seaweedfs": { "files": 0, "directories": 0, "bytes": 0 }
  }
}
```

### Secret boundary change

The logical export excluded `fleet/peer-auth.json` and scanned every object for the store's S3 credentials. A raw copy of `seaweedfs/` cannot do either. The archive now contains the internal peer key and every bucket object. Configuration, the S3 credential file (`s3.json`), `celld.env`, client private keys and Alchemy state live outside the data root and stay excluded. The known-key filename check still applies to `celld/`. **Treat the share as secret-bearing.**

## The 2026-10-09 publication hang

Evidence from the 10:00Z run: compression finished locally by 10:05Z, and nothing appeared on the share, not even the hidden temporary directory. The old publisher created that directory only after it had validated both compressed archives locally. The process was therefore stuck in that local validation, before any CIFS call. Validation walked about 345,000 objects through a SQLite seen-set and a per-object tar read. It used about 80 seconds of CPU in 2 hours, so it was blocked, not computing. The unit's peak of 167–175 MB was above `MemoryHigh=128M`. That points to memory.high reclaim throttling, which the host owner suspects. A CIFS stall did not cause this run, because CIFS was never touched. The cause is inferred, not proven.

The new path removes that validation entirely. Publication reads one file sequentially, with bounded windows. The job logs the unit cgroup's `memory.events` (including the `high` count), `memory.pressure`, `memory.current`, `memory.peak`, `memory.high`, and the `anon`, `file`, `file_dirty` and `file_writeback` fields of `memory.stat`. It logs them before the stop and at the start and end of publication, so the next run settles the question. Memory limits are unchanged: `MemoryHigh=128M`, `MemoryMax=256M`, zero swap, 25% CPU and 64 tasks in `rat-king.slice`. If the logs show `high` events climbing during publication, the next step is to run publication in its own transient unit with a looser `MemoryHigh`. The brief allows that; this packet does not do it.

## Restore

`restore-snapshot` restores in place on the deployed host:

1. While the mailbox serves: copy the newest format-4 archive, or a named one, from the share to `.mailbox-restore-<hex>/` under the data root. Check its SHA-256 against the manifest. Inflate every member with CRC checking, allowing only regular files and directories under `celld/` and `seaweedfs/`, and compare counts and bytes with the manifest.
2. Stop celld, then SeaweedFS.
3. Re-hash the local archive. Move the current `celld/` and `seaweedfs/` into `.mailbox-restore-aside-<timestamp>-<hex>/`. Unpack with Python's `data` filter, directories at 700 and files at 600. Check counts and bytes again.
4. If unpacking fails, move the partial trees aside as `partial-*` and move the previous directories back.
5. Start SeaweedFS, then celld, whether or not the swap succeeded. Then run the exact-listener gate.

The aside directory is never deleted automatically. The restored data matches the S3 credentials in the host's existing configuration only when the snapshot came from the same deployment. A fresh host must deploy first and must have the same `s3.json`, or SeaweedFS will hold buckets the new credentials cannot read. That case is not qualified.

### Old formats

`restore` (fresh target) still reads format-2 and format-3 logical backups and format-1 object indexes, through the unchanged import path. It refuses to run when the newest complete backup is format 4, so it cannot silently pick an older backup. Retaining it costs nothing beyond keeping the existing reader. The S3 export (pre-copy, final delta and pack) is removed; nothing else used it. Commit `eb78405` is the last commit that can _write_ format 3.

## Cleanup

After a verified publication only, cleanup removes:

- local `.mailbox-backup-<32 hex>` staging directories whose children are only names the job writes (old export files, `snapshot.json`, `archive.json`, `mailbox.tar.gz`, and the `celld`/`seaweedfs` copy trees);
- local `.rk-backup-mem-<8 digits>.log` regular files;
- hidden `.mailbox-publish-*` directories, and dated directories without a manifest, whose children are only known publication filenames. This includes empty ones such as the 2026-10-09 03:27Z partial.

It does not follow symlinks and preserves foreign files and any directory with a foreign child. It never removes a dated directory with a manifest, or anything under `.mailbox-restore-*`.

## Local synthetic measurement

On uncapped macOS (APFS, with no `FICLONE`, so the real-copy path ran):

- celld: 2,000 files in 50 directories, 53,248,000 bytes.
- seaweedfs: 40 files, 1,343,488,000 bytes; volumes half random, half zero.
- Copy and verify of both trees: 1.405 s.
- Pack: 12.194 s, producing a 729,082,938-byte archive.
- Local share copy: 0.615 s. Readback verify: 0.282 s.

These are not capped Linux, CIFS or stop/start measurements. Real volumes compress differently. On Linux the copy uses a reflink only on filesystems that support it (XFS, Btrfs). On ext4 it copies.

## Qualification still required

Local tests drive a fake host model and real files. They are not deployment proof. The desk must:

- measure the stop and start time on the host;
- check that SeaweedFS's graceful stop reports `Result=success`;
- read the memory telemetry from the first run;
- take a manual backup and verify it on the share;
- run `restore-snapshot` in an approved drill and prove that a previously registered recipient decrypts pre-backup mail;
- exercise SIGTERM, SIGKILL and OOM recovery.

No deployment is authorized by this packet.
