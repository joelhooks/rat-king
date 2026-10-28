# Give celld room to stop and alarm on anonymous memory

The backup logs memory before stopping celld. It never refuses a stop because of memory. The snapshot still requires a clean shutdown of both writers.

## Evidence and limits

The incident's three systemd lifetime memory peaks were 3.4G, 3.1G and 4.5G. The last run hit celld's own 4.5 GiB cgroup cap two seconds after its stop began. The successful fresh-process retry reached 3.3G in a five-minute process lifetime. These are lifetime peaks, not steady-state measurements. They do not quantify the shutdown delta.

The owner's kernel evidence identified about 4.62 GB of anonymous RSS and only 3 MB of file RSS at the kill. This was real anonymous demand, not just file cache charged to the unit. A later cgroup sample had about 0.81 GB anonymous memory and 0.63 GB file cache in celld. Storage had about 1.44 GB anonymous memory and a 3.91 GB lifetime charged peak. The original 8 GiB slice had little room for coincident service peaks and the backup worker.

The affected process adopted generations 2 through 17. Its journal records every previous generation, 1 through 16, freed before the failed stop. The pinned source, `ce4f4dc3514cd5cce209a77bebafdae8d69afdcc`, retires the previous generation in `crates/celld/runtime.rs::adopt`; `watch_generation` removes it once its pools drain. Persistent old generations are not supported as this incident's cause.

Upstream issues [275](https://github.com/denoland/celld/issues/275) and [289](https://github.com/denoland/celld/issues/289) describe genuine background-work/request retirement leaks on v0.6.2. They explain what to look for, not what happened here. The published v0.6.1–v0.6.3 release notes do not claim a fix for this stop OOM.

The failed stop's journal shows concurrent `ltx_handoff_snapshot` publications and eviction durability barriers. The pinned `crates/celld/ltx_repl.rs::prepare_handoff_snapshot` builds each eligible full snapshot into a `Vec`, keeps it for publication retries, and passes its bytes into `publish_handoff_snapshot`. That establishes a shutdown allocation mechanism, not its total contribution to the kill. Whether anonymous memory climbs during normal service or spikes mainly at shutdown remains open.

Existing `BACKUP_MEMORY` lines describe the backup worker's cgroup, not celld. They cannot establish celld's pre-stop charge. The private health-history and deploy-receipt files were unavailable in the investigation checkout. No isolated celld workload reproduction was run. No live units were changed by this work.

## Limits and arithmetic

`fleetMemoryLimits` in `stop-memory.ts` supplies the fleet declarations:

- Celld: `8G`, or 8 GiB. The 4.62 GB anonymous kill sample is about 4.30 GiB. The new cap leaves about 3.70 GiB above that sample. A cgroup cap also covers file and kernel memory, so that is not all free application headroom.
- Storage: `4608M`, or 4.5 GiB, unchanged. Its 3.91 GB charged peak is about 3.64 GiB, leaving about 0.86 GiB below its cap.
- Shared slice: `14G`, or 14 GiB. Both service caps total 12.5 GiB. The slice leaves another 1.5 GiB for the backup worker and other members. This is margin, not a guarantee that every member can reach its individual cap simultaneously.

`config.ts` now defaults the fleet slice to `14G`. `RAT_KING_SLICE_MEMORY_MAX` remains an explicit override, but the normal fleet deployment needs no new environment setting. Pilot and proof defaults stay unchanged. The host owner's available-memory measurement supports increasing these bounded caps; host protection remains in place.

## Alarms and pre-stop evidence

The shared `unit_memory` reader asks systemd for each unit's `ControlGroup`, `MemoryCurrent`, `MemoryMax` and `MemoryPeak`. It reads `anon` and `file` from that cgroup's `memory.stat`, not the cgroup root or the collector's own cgroup. Unreadable values become null. Each systemd sample has a three-second timeout.

Health persists samples for celld and storage under `stopMemory`. The digest warns, and the existing `digest.fail` fleet alarm fires at warning severity, when either unit's anonymous memory reaches 60% of its observed unit cap. At the declared caps, those thresholds are 4.8 GiB for celld and 2.7 GiB for storage. Charged file cache, lifetime peaks and slice charge do not trigger this warning. Missing anonymous accounting or an unusable unit cap also warns. Older digest rows remain decodable.

The warning runs throughout the day, not only near the nightly timer. It leaves 40% of each unit cap for investigation and growth. It cannot guarantee hours of notice for a sudden shutdown allocation burst.

Immediately before arming recovery, `BACKUP_STOP_MEMORY` logs `anon`, `file`, `current`, `max` and `peak` for celld, storage and the slice. High memory, missing files, malformed samples and sampling timeouts do not prevent arming. Existing unit-age, restart-marker and clean-shutdown guards remain intact. Comparing these pre-stop samples with the post-stop peak and periodic anonymous-memory samples should distinguish ordinary growth from a shutdown spike.

The earlier fixed-headroom refusal is removed. Its 2 GiB charged-memory cutoff could defer a healthy backup and its warning could fire on ordinary cache. Restarting on every Worker deploy is not justified by the generation-free evidence.

## Deployment, plan and rollback

The desk owns deployment and the planned restart notice. Refresh the backup runner and the operator bundle used for health and alarms. No shared lifecycle policy changes or new flags are introduced.

The expected memory-only plan is a slice update, a celld update with a planned restart, and a storage no-op. Celld's unit text changes from `MemoryMax=4608M` to `MemoryMax=8G`. Storage's rendered unit text and process fingerprints stay unchanged. The slice hash is a readiness dependency, not a storage restart fingerprint. Reconciliation reloads the slice without restarting it. Celld requires storage, not the reverse, so a celld restart does not restart storage. The reconciliation model checks this classification, the staged declaration path and repeated no-op application. The desk must confirm the real plan against its saved state; unrelated drift can change it.

Resource declarations also require exclusive control of declared resource directives. Planning and reconciliation inspect systemd's effective `DropInPaths` and refuse persistent or runtime `systemd/user.control` files that assign a declared resource directive, even when the values match. The refusal names the file and directive and gives a reversible `mv -n` command, followed by manager reload and a fresh plan. It does not delete operator files or change services. Ordinary non-control drop-ins and undeclared directives are outside this guard. An unreadable control drop-in also refuses because its effect cannot be checked. Reconciliation rechecks before writing or changing lifecycle state.

Removing a matching override only preserves the effective limit if the underlying unit has the same limit. `daemon-reload` does not restart services, but it can apply a lower resource limit. Review the underlying declaration and any runtime override hidden by a persistent file before disabling either. A reload can reveal another override; re-plan until every declared-resource conflict is resolved.

A post-ship investigation found that the deployed slice declaration had remained at 8 GiB because an explicit stage runtime value overrode the public default. The full apply had not skipped slices. The operator corrected that explicit value to 14 GiB. Public defaults cannot override explicit configuration; inspect the resolved stage value and unit text, not just the source default.

Deploy while anonymous memory is low, as a planned celld restart with notice. Then confirm exact version, health and memory limits. At the next authorized backup, inspect `BACKUP_STOP_MEMORY`, clean unit `Result=success`, the celld post-stop peak and a verified complete archive. Root-cause measurement remains open; larger caps mitigate the measured failure but do not bound future anonymous growth.

Rollback restores the previous bundles and declarations. Restoring celld's old cap changes its unit text and can restart it under existing policy. Do not lower a cap under current demand; the desk must inspect memory first. Rollback does not restore data. Until the desk deploys the new limits, the original stop OOM risk remains.
