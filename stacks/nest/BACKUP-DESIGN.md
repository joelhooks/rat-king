# Mailbox backup design

## Consistency and stop time

The backup pre-copies logical S3 objects while celld serves. A SQLite catalog holds keys, response ETags, spool offsets and checksums on disk. Listings contain at most 1,000 objects. GET bodies stream in 1 MiB chunks into an append-only local spool. Live deletions are tolerated during pre-copy. A changed GET records its actual response ETag, not the earlier listing ETag.

After a successful celld shutdown, the backup lists the bucket again. It reuses objects with matching ETags, downloads additions and changes, and excludes deleted objects. It then copies the local celld directory. Celld restarts before archive construction, validation, hashing or SMB publication. Only the stopped final listing defines the snapshot. The live pre-copy alone is never published.

The final delta has a 15-second alarm. The local snapshot has a separate 5-second alarm. Exceeding either budget fails the backup and attempts guarded restart rather than extending the outage. These budgets exclude celld's graceful shutdown and guarded startup, whose real durations still need measurement. A final listing still scales with object count; this is not a constant-time snapshot. If that listing cannot fit its budget on the live host, the desk must keep the nightly job paused and take the approved manual backup. Raising the stop budget is not an automatic fallback.

No external whole-node checkpoint API was found in the pinned celld routes/CLI. The internal SQLite snapshot helper is per-cell and is not a whole-mailbox consistency boundary. SeaweedFS's S3 listing is paginated, not a transactional bucket snapshot. Copying raw volume files would also capture excluded peer authentication data. Therefore this change uses a stopped final reconciliation, not an unsupported live snapshot or raw-volume backup.

Source evidence:

- [celld v0.6.1 HTTP routes](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/main.rs), including `/state`: diagnostic state, not a backup API.
- [celld v0.6.1 SQLite snapshot helper](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/replication.rs#L422): a committed per-cell SQLite snapshot.
- [SeaweedFS 4.48 S3 listing](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/s3api_object_handlers_list.go): continuation markers and filer directory traversal. The exporter requires strictly increasing keys and fails closed on duplicate/cyclic pagination.

## Memory and format

New `objects.tar` files start with `format.json` containing `{"format":2}`. Each object is an `entry.json` metadata member immediately followed by its hashed-name blob member. A reader validates order, safe paths, uniqueness and each payload checksum. Duplicate tracking lives in a temporary SQLite database with a 2 MiB page cache. Writers and readers explicitly clear Python tarfile's member cache. No new-format index, key set, payload or tar member list grows in RAM with the store.

The outer manifest remains format 2 and retains both archive SHA-256 hashes, version and commit. Restore accepts the old format-1 object archive as well as the new streaming format. The legacy reader retains its existing 16 MiB index limit; memory bounds claimed here apply to the new format. Restore validates the complete archive before the first S3 write, streams each verified object through a temporary file and checks GET readback. Peer-auth and known credential/config paths remain excluded. Export scans current credential values across chunk boundaries.

Disk usage grows with exported bytes and catalog size, not with RAM. The spool can retain superseded pre-copy bytes until successful publication. The job keeps the existing 256 MiB unit cap, slice, CPU and task caps. No listener changes.

## Recovery

The job durably arms a restart marker before requesting celld stop. It removes the marker only after a successful guarded start. Ordinary failures attempt that start in the Effect runner. `ExecStopPost` independently checks the marker and starts celld after a worker error, timeout, OOM or SIGKILL. `OOMPolicy=stop` makes an OOM stop the service before the hook runs. A failed celld start preserves the marker and fails the hook; the existing startup gate is never bypassed. This cannot guarantee availability if celld itself cannot start, the user manager dies, or the entire host is lost.

Cleanup happens only after publishing the manifest. It removes only `.mailbox-backup-<32 lowercase hex>` directories containing recognized regular staging files. Foreign files, nested directories and symlinks are preserved. Nothing on the backup share is deleted.

## Growth

The pinned celld already runs bundle and fragment GC, and defaults to additive L1 compaction. The node unit now sets `CELLD_LTX_RETENTION_SECS=604800` (seven days), enabling supported owner-side GC of old epochs outside the restore chain. This does not delete live-chain data, the current epoch or the immediately previous epoch. It does not promise a hard object-count bound for an indefinitely hot current epoch, read-only cells, inactive cells or facet streams. A private environment that selects bucket durability disables this GC.

Sources:

- [celld bundle GC and maintenance loop](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/node_log.rs#L6251): deletion requires covered per-cell rows, not age-based guessing.
- [celld supported retention and compaction settings](https://github.com/denoland/celld/blob/v0.6.1/docs/README.md#L1109).
- [celld GC dry-run and caveats](https://github.com/denoland/celld/blob/v0.6.1/docs/README.md#L1022).

The smallest safe follow-up is `celld cell gc --dry-run` on the deployed version and inspection of bundle GC/compaction progress. If hot current epochs still grow, qualify a supported whole-database handoff/epoch rotation with celld upstream. Do not add an S3 age-deletion rule for `log/` or `cells/`.

## Local synthetic measurement

A 500,000-object fake S3 store with 66-byte payloads exercised the actual exporter, unchanged final reconciliation, archive writer and validator. Python peak RSS was 42,811,392 bytes (40.8 MiB). Pre-copy took 11.394 seconds, final reconciliation 3.831 seconds, packing 15.499 seconds and validation 84.046 seconds. There were 500,000 object GETs total and 1,000 listing pages across the two passes. The tar writer retained at most one member. The resulting archive was 1,024,010,240 bytes.

This is a local synthetic adapter measurement, not a network benchmark, combined Node/Python cgroup measurement, or capped-host outage proof. Ten-times-incident object count was not measured. The new-format memory bound follows from paginated listings, fixed chunk sizes, disk indexes and explicit tar member-cache release; the property test checks member retention. Restore roundtrips use generated small payloads and fresh invented credentials, not 500,000 live objects.

## Qualification still required

Local tests are fake S3/systemctl tests, not deployment proof. The desk must measure the final listing, full stop/start interval and combined cgroup memory under the existing caps. It must exercise systemd OOM/SIGTERM/SIGKILL recovery, take a manual backup, restore it in an approved fresh target, and prove a previously registered recipient decrypts pre-backup mail. No deployment is authorized by this packet.
