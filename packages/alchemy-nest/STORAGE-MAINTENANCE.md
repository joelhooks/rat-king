# Filer log retention and storage diagnostics

Code-ready only. The desk deploys this declaration; this change does not deploy it.

## Pinned source findings

The binary remains SeaweedFS **4.48**, pinned in `src/pins.ts`. Source tag `4.48` resolves to `530be3e37337488ecc34d58441e0bc476e121c93`.

- [`weed/filer/filer_notify.go`](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/filer/filer_notify.go) emits metadata change events and flushes them to `/topics/.system/log/YYYY-MM-DD/HH-MM.<filer-id>`. Changes within the system-log path are excluded from notifications, so retention does not recursively log itself.
- [`weed/filer/filer_notify_append.go`](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/filer/filer_notify_append.go) assigns log chunks with collection, replication, disk type and growth count. It does **not** pass a TTL to volume assignment or set an entry TTL. A path TTL rule therefore cannot bound these chunks in this version.
- The pinned `weed/command/server.go` and `weed/command/filer.go` expose no metadata-log disable or retention flag. The S3 lifecycle design explicitly describes the metadata log as unbounded without operator retention: [`weed/s3api/s3lifecycle/DESIGN.md`](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/s3lifecycle/DESIGN.md).
- The log supports filer metadata subscription/replay, not the mailbox's own durable message log. Neither the mailbox nor celld's pinned source accesses `/topics/.system/log` or the filer subscription API. They use the S3 object interface. This is **not** permission to disable the filer's internal log: SeaweedFS has its own metadata consumers. Seven days is the retained replay window, not an unlimited-history guarantee for those consumers.

## Retention

`ObjectStore.Bucket` declares a mode-600 Python adapter, an hourly user timer and an unenabled, not-started oneshot service invoked by that timer. The service is in `rat-king.slice`, with 128 MiB memory, no swap, 10% CPU, 32 tasks, nice 10 and `Restart=on-failure`. Restarts are limited to three per hour. The timer catches missed calendar runs after downtime.

The adapter completes a bounded, paginated JSON listing of the exact log root before deleting anything. It deletes only canonical UTC date directories **strictly older than today minus seven days**. The boundary day remains, so the window spans between seven and eight days, plus up to one hourly timer interval. Files, invalid dates, encoded paths, nested paths and other prefixes are ignored. An unexpected root, failed request, stalled cursor or page-budget exhaustion fails closed. Requests disable proxies and refuse redirects. Deletion uses the filer's documented `DELETE ?recursive=true`, including chunk deletion, without `ignoreRecursiveError` or `skipChunkDeletion`.

This deletes logical log entries, not raw volume files. Physical reclamation uses SeaweedFS's existing automatic vacuum (server default: 840 seconds, garbage threshold 0.3). No new vacuum job or raw-volume deletion is added. Vacuum must remain enabled and healthy; retention alone cannot prove recovered capacity. Slot exhaustion and an unwritable default collection remain alarms.

## Read-only hawk proposal

Keep `/.well-known/celld/health` and its `200 {"ok":true}` contract unchanged. Do not add a listener. The hawk owner can approve a separate host-side check:

```sh
/usr/bin/python3 "$HOME/.local/share/rat-king/bin/storage-maintenance.py" diagnose
```

It performs **only GET** against the existing loopback master `/dir/status`. JSON includes `observedAt`, `freeVolumeSlots`, `maxVolumeSlots`, `defaultCollectionWritableVolumes` and `alarm`. The writable count matches the empty collection, replication `000`, no-TTL layout. This is the master's current writability view, **not** a successful conditional-write proof and not a check of all bucket collections.

Proposed hawk cadence: one minute. Alert immediately on free slots **< 8**, zero default writable volumes, command failure or unavailable/stale diagnostics. Exit 0 means the counters passed; exit 1 means alarm or unavailable. Treat a missing/malformed signal as unhealthy, never as zero usage. The desk relays this proposal; this packet does not change the hawk.

The hourly retention pass also prints this signal to the journal. Celld's `ExecStopPost` runs the read-only diagnostic on every exit, including startup failure. If the master reports zero writable volumes, the journal says `storage has no writable volume in the default collection; node authority writes may fail`. The original celld exception remains intact. The diagnostic's exit status is ignored for celld, preserving its existing failure exit and restart policy.

## Qualification and rollback

The property test runs the real Python functions against fake HTTP responses. It covers generated retention ages, pagination, path confinement, boundary-day preservation, malformed-listing refusal, read-only diagnostics and alarm counters. It also validates the unit declarations and celld's exit diagnostic hook.

No live rehearsal is authorized. Untested here: live filer deletion and vacuum reclamation, timer execution, systemd stop-hook journaling and hawk consumption. The desk should inspect timer/journal state, run `diagnose`, verify the exact listener gate remains 10, and observe log retention plus capacity recovery after its authorized deploy. Rollback restores the previous declarations and removes the added timer/service/script through Alchemy. Deleted historical log segments cannot be restored by code rollback; mailbox objects are outside the deletion scope.
