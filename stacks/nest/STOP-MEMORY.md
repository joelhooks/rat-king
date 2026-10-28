# Reserve memory before stopping celld

The backup keeps the mailbox running when it cannot prove enough shutdown headroom. It does not restart celld to make room: a restart takes the same shutdown path that failed.

## Evidence and limits

The incident's three systemd memory peaks were 3.4G, 3.1G and 4.5G. The last run hit celld's own 4.5 GiB cgroup cap two seconds after its stop began. The successful fresh-process retry reached 3.3G in a five-minute process lifetime. These are lifetime peaks, not steady-state measurements. They do not prove a sustained leak or quantify the shutdown delta.

The affected process adopted generations 2 through 17. Its journal records every previous generation, 1 through 16, freed before the failed stop. The pinned source, `ce4f4dc3514cd5cce209a77bebafdae8d69afdcc`, retires the previous generation in `crates/celld/runtime.rs::adopt`; `watch_generation` removes it once its pools drain. Persistent old generations are not supported as this incident's cause.

Upstream issues [275](https://github.com/denoland/celld/issues/275) and [289](https://github.com/denoland/celld/issues/289) describe genuine background-work/request retirement leaks on v0.6.2. They explain what to look for, not what happened here. The published v0.6.1–v0.6.3 release notes do not claim a fix for this stop OOM.

The failed stop's journal shows concurrent `ltx_handoff_snapshot` publications and eviction durability barriers. The pinned `crates/celld/ltx_repl.rs::prepare_handoff_snapshot` builds each eligible full snapshot into a `Vec`, keeps it for publication retries, and passes its bytes into `publish_handoff_snapshot`. That establishes a shutdown allocation mechanism, not its total contribution to the kill. The exact source of the lifetime peak remains open.

Existing `BACKUP_MEMORY` lines describe the backup worker's cgroup, not celld. They cannot establish celld's pre-stop charge. The private health-history and deploy-receipt files were unavailable in the investigation checkout. No isolated celld workload reproduction was run. No live units were changed.

## Policy

`stop-memory.ts` defines a 2.5 GiB shutdown reserve. Immediately before creating the restart marker, `arm` reads `MemoryCurrent`, `MemoryMax` and `MemoryPeak` for celld and its shared slice. Both must have at least that reserve. Missing, unlimited and unset accounting refuses the stop. The refusal leaves the marker absent and never controls either service. The runner logs the numeric observations as `BACKUP_STOP_MEMORY`, including on refusal.

The health collector persists those same three counters under `stopMemory`. Below 3 GiB of headroom, the digest warns and the existing `digest.fail` fleet alarm fires at warning severity with the measured headroom and next action. This applies throughout the day, not just near the nightly timer. Unknown accounting also warns. Old digest rows remain decodable. The warning has 512 MiB of runway before the refusal; it cannot promise hours of notice for a sudden allocation burst.

The reserve is conservative operational policy, not a proven upper bound on shutdown allocations. Concurrent allocation can outrun a sample. Charge includes reclaimable cache, so a refusal can be conservative. A refused run takes no backup; the owner must restore headroom and retry, without bypassing the clean-shutdown guard. Backup freshness alarms still apply.

Both service caps and the shared slice cap stay unchanged. Raising celld's cap would borrow protection from storage without bounding the snapshot burst. Setting a new celld pressure threshold could shed work and change availability without a qualified workload proof. Restarting on every Worker deploy is not justified by the generation-free evidence.

## Deployment and proof

The desk must install the rebuilt backup runner and refresh the operator bundle that collects health and alarms. No celld, storage or timer declaration changes are needed. There is no new flag. Reverting these source changes and restoring the prior bundles rolls back the safeguard, not data.

Before the next scheduled run, read back `stopMemory` from the deployed health collector. Check that warning evidence reaches the existing fleet alarm when headroom is low. At the next authorized backup, compare `BACKUP_STOP_MEMORY` with celld's post-stop peak, confirm `Result=success`, and verify a complete backup. If the guard refuses, inspect memory growth and restore headroom before retrying. Until deployed, the existing stop OOM risk remains. After deployment, a backup can still be deferred by the guard; successful nightly publication is not guaranteed by this packet.
