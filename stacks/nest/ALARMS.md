# Fleet alarms

`alarm` launches one lock-owning Effect worker through macOS `lockf`. `alarm-plist` prints its launchd declaration. The desk installs it; this lane does not install, enable or send live messages. Configuration must explicitly set `alarm.enabled: true` to run. `alarm-check` reads and prints sanitized source conditions without writing alarm state or sending notifications.

## Lifecycle and delivery

One XState machine per stable key holds `ok`, `firing` and `recovered`. SHA changes, different diagnostic text and repeated known failures do not create new keys. A key sends on entry, a severity increase or the reminder interval (default 120 minutes). Recovery sends once with incident duration. Unknown measurements retain the previous alarm instead of claiming recovery.

The private stage directory holds `alarms.jsonl` at mode 600. Each changed checkpoint is appended and fsynced before dispatch. It contains machine states, measurement trackers, page claims and a durable outbox. Malformed history or non-private files block reads; the loop never discards history to forget alarms. Preparation failures retain one queued notice per incident/kind. Once prepared, the signed plaintext envelope is persisted before submission. Retries replay that exact envelope, preserving the mailbox's sender-DID/TID idempotency identity. Accepted deliveries are checkpointed individually. An earlier failed delivery blocks later messages to the same recipient, so a late fire cannot follow its own all-clear.

Pages go to Joel's phone and grokbot, so they carry real incidents only. Warn never pages. A critical pages only when all of these hold: it is firing now, outside any maintenance window (a covered reading is `maintenance`, never `firing`); it is confirmed by two consecutive samples or five minutes of firing; and its owner has not acked it within ten minutes of `since`. No alarm ack transport exists yet, so the ten-minute wait always runs out (TODO: an owner ack). Each incident's id is its `since` in epoch milliseconds, printed as `Incident <id>` in every fire text. One incident pages at most once, even when its severity rises. When a paged incident clears, one page says `cleared <key> <id> after <seconds> seconds`. `mail.stranded/<name>` passes the same operator gate; ordinary mail wait and owner opt-ins never page. A key cannot reserve another fire page for six hours; all keys share at most six fire pages in a rolling 24-hour window. Clear pages do not count against either budget. Page records for a still-firing incident outlive the 24-hour window, so a long incident never pages twice. The page slot is reserved before the gateway runs, and a failure or uncertainty consumes it rather than risk a duplicate. Pages are independent of Rat King delivery, so a broken issuer can still reach Joel. Successful page execution requires exit zero and JSON `ok: true`.

## Configuration

`stage.json` owns all identities, recipients, paths, commands and owner mappings. Add an optional `alarm` section with:

- `enabled`: explicit boolean, initially false.
- `broadcast`: destination agent name for operator alarms, excluding retired wake alarms and owner-only opt-ins.
- `musterDesk`: the configured Muster desk name, included for `readers.*`, `issuer.*` and `mail.stranded/*`. A firing `readers.stuck` also goes to each stuck reader's owner, named in its heartbeat (`MUSTER_OWNER_NAME`). The all-clear goes to the static recipients only.
- `owners`: key or dotted-prefix to owning desk. The longest matching prefix wins. Recipient fan-out is deduplicated.
- `renotifyMinutes`: optional positive integer, default 120.
- `notify`: operator identity secret, directory path and optional Pi config path. The sender is always `operator`; its identity must match the directory's operator DID.
- `page`: Node executable and the approved notification gateway script path.
- `launchd`: label, Node executable, checkout `source`, PATH and output/error log paths.
- `readerHeartbeats`: one entry per host, with a display `host`, the Pi state's `readers` directory as `dir`, and an `ssh` destination for every host but the alarm's own. The worker reads each host's heartbeats with one bounded call per check (10 seconds, `BatchMode=yes`). Pid liveness is checked on that host. If the list is omitted, reader monitoring is unknown, not healthy. If a host's directory is missing, that host has no readers. The older `readers` list with `aliveCommand` is ignored. It is accepted only so existing configs keep loading, so delete it when you add `readerHeartbeats`.

Optional `alarm.wakeTargets: [{ name, owner, unackedMinutes?, page? }]` preserves explicit owner opt-ins. The threshold defaults to `alarm.wakeUnackedMinutes` (15 minutes when omitted). Each overdue target fires `mail.owner/<name>` to its owner only, never to broadcast, the desk or the operator gateway. The legacy `page` option still decodes but no longer grants operator paging authority. Owner notices and their recovery use the normal durable outbox.

Use a fresh copy of the live stage config. Do not promote an older proposal that loses approval fields or notification recipients.

## Sources

- `ship.failed`: latest failed receipt; public SHA and sanitized cause. Missing/unreadable receipt history is unknown, not recovery.
- `ship.churn`: warn when more than `ship.restart.churnLimit` (default 3) ship receipts report a celld restart within the last 24 hours. It never blocks a restart. Missing receipt history is unknown.
- `celld.down`: two failed health checks outside a fresh `restarting` marker's 180-second window. The marker is read on the configured live node, not from the alarm host's filesystem. Unknown marker readback cannot prove that a restart window has ended.
- `celld.restarted`: ActiveEnter moves after the initial baseline without a receipt that reports a real restart spanning that instant. It remains firing until an explaining receipt appears. Deploy-time observations wait for receipt/window resolution. A maintenance window run by `celld-window.sh` appends a window receipt (`kind: "window"`, epoch-second `start`/`end`, reason, approval, result, before/after celld PID and ActiveEnterTimestamp) to `window-receipts.jsonl` beside the deploy marker on the live node; the alarm reads it there like the marker, skipping malformed lines; a restart inside `[start, end]` is explained. Window receipts are separate from ship receipts, so the ship judge never reads them. A missing or unreadable window file explains nothing.
- `issuer.broken`: failed or unavailable configuration doctor.
- `readers.stuck`: warn when a heartbeat's pid is alive and its reader has made no lease or consume progress for over 5 minutes. Progress is `lastConsumeOk`, or `startedAt` before the first lease. Evidence names each reader, its host, state, last error tag and idle minutes. A heartbeat whose pid is dead is stale and ignored. An unreadable host makes the reading unknown, unless another host already shows a stuck reader.
- `wake.unacked`: retired. Existing journal states still decode. The first cycle drops the old state, queued notices, pending deliveries and page records without sending a fire or clear.
- `mail.stranded/<name>`: critical only when wake mail has waited strictly more than four hours and the reader process is dead, its lease is missing or expired, or the current lease holder has an observed turn start older than four hours. Heartbeat sessions must match the current holder before process liveness is trusted. Mailbox turn observations select `working` records for that holder, not completion times. Missing turn observations do not prove inactivity. Each reader has its own lifecycle and page claim, subject to the normal operator gate and budgets. A complete drained snapshot or a returning live reader with recent turn activity clears its own incident. Targets with pending mail remain queried after their heartbeat disappears. Live readers with waiting mail appear in the health digest’s `waitingMail` lines without changing digest status or creating a wake.
- Cross-restart re-delivery is not inferred from a lease generation change. The current health projection exposes message IDs and lease generations, not consume-attempt history. Follow-up: record consume-attempt receipts with message ID, recipient name, a reader-instance ID minted on reader startup, lease generation, attempt time and ack time. Expose only this metadata through an operator read endpoint. Retain receipts while the message is unacked. Page only when the same unacked ID has confirmed attempts from two distinct reader instances, not merely two lease generations; ack or drain clears that reader’s incident. This requires mailbox-owned data, not journal guesses.
- `filer.slots`: free/max below 10 percent, critical below 5 percent. Missing values or zero capacity are unknown.
- `quarantine.growth`: more than twenty files with fresh modification times in the preceding hour, summed across both configured quarantine roots. The quarantine-only collector does not read sessions or route receipts.
- `digest.fail`: latest digest is fail, or a source measurement was unavailable. Missing history is unknown. Inside a mailbox maintenance window, missing stop-memory accounting is planned (celld is stopped), so it does not warn.

## Maintenance windows

Anyone restarting a Rat King instance declares the window first, on the alarm host:

```
nest maintenance start --instance mischief --until 16:40Z --owner pi-durable/desk --reason "Jev key deploy" [--grace-minutes 5]
nest maintenance end --instance mischief
nest maintenance list
```

`--instance` is a configured `alarm.instances` name or `mailbox`, the stage's own celld. `--until` takes `HH:MMZ` (the next time the UTC clock shows it), `+30m`/`+2h`, or an ISO time with a zone. It must lie in the future and at most 12 hours out, so a typo cannot hide an outage. Grace defaults to 5 minutes. A new window for an instance closes its open one; `end` closes it now, and grace still runs from then. The file is `maintenance.json` in the stage state directory, mode 600, replaced atomically. The alarm reads it on every tick, so a declaration takes effect without restarting the daemon. A missing file declares nothing. An unreadable file declares nothing, and the alarm names `maintenance` among its unavailable measurements.

Inside a window (from start to end plus grace), `instance.down` for that instance, and `celld.down` for `mailbox`, read `maintenance by <owner>, ends HH:MMZ`. That goes once per window, quietly, to the owner only: no broadcast, no Muster desk, no page. A mailbox restart inside the window explains `celld.restarted`. The alarm machine holds its state through a maintenance reading, as it does through an unknown one. A window covers only its named instance and only until its end plus grace. After that the alarm runs as usual, and if the instance has not been seen up since the window ended, the evidence adds `overran maintenance by <owner> (<reason>) that ended HH:MMZ plus N min grace`. Overruns page through the normal gate.

The nightly backup is an implicit `mailbox` window owned by `backup`. It starts at the backup unit's `ExecMainStartTimestamp` and ends when the unit exits, or at most 25 minutes after the start: the backup refuses to stop celld once its unit is 20 minutes old, then allows a 90-second stop, a 45-second snapshot and the restart. A backup still running past that budget alarms as an overrun. Backup windows have no owner to notify, so they send nothing; `alarm-check` shows them as `maintenance`. Health digests taken inside the backup's stop budget list stopped celld or SeaweedFS, mailbox health and missing memory accounting as `maintenance by backup: …` reasons that do not change the digest status.

Source probes have bounded deadlines. The worker targets a 60-second cadence and bounds each cycle at 55 seconds. There are no service-control actions, listener processes or recovery automation in this loop.

## Qualification

Run property/model tests, then `alarm-check` with approved private selectors. Run `alarm-check` and confirm that each configured host's heartbeats are read. The desk should test operator fan-out and the configured Joel gateway under its live-message approval, install the printed plist once, and inspect journal delivery/page claims. Roll back by disabling or unloading this one desk-owned job; no infrastructure or mailbox data rollback is involved.

Untested by this lane: live fan-out, a real Joel page, launchd restart supervision and the ssh path to a remote heartbeat host. The property suite covers lifecycle/restart replay, stable-key dedupe, page budgets, source thresholds, deploy grace and encoded envelope replay. Filesystem quarantine freshness uses modification time, not a claim about file birth time.

## Crash notices: retries, refusals and logs

- A crash notice whose recipient the mailbox refuses as `Retired` or `UnknownName` is terminal. With a successor named in the refusal, the notice is re-sealed to the successor once. Otherwise, or if the successor refuses too, the key moves to `sent` and is recorded under `dropped` with the reason.
- Other send failures back off per entry: 2 s doubling, jittered down by up to half, capped at 10 minutes. The journal's `attempts` and `nextAt` are optional, so older journals read as due now. Only the first failure and the recovery are logged.
- The alarm and ship runners exit for a launchd restart when the ship checkpoint's `successful` sha changes, meaning a commit from `origin/main` was deployed. Commits made in the local checkout do not restart them.
- Once per cycle the worker checks `alarm.out.log` and `alarm.err.log`. Past 16 MiB it gzips the file's current bytes to `<name>.<utc>.log.gz` beside it, fsyncs the archive, and truncates the live file. launchd owns those files and keeps appending through its open descriptor, so renaming would send new output into the archive. Copy then truncate keeps launchd's descriptor valid. Archives older than 30 days are removed. The first rotation after deploy archives the existing large log.
