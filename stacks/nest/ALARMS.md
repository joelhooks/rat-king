# Fleet alarms

`alarm` launches one lock-owning Effect worker through macOS `lockf`. `alarm-plist` prints its launchd declaration. The desk installs it; this lane does not install, enable or send live messages. Configuration must explicitly set `alarm.enabled: true` to run. `alarm-check` reads and prints sanitized source conditions without writing alarm state or sending notifications.

## Lifecycle and delivery

One XState machine per stable key holds `ok`, `firing` and `recovered`. SHA changes, different diagnostic text and repeated known failures do not create new keys. A key sends on entry, a severity increase or the reminder interval (default 120 minutes). Recovery sends once with incident duration. Unknown measurements retain the previous alarm instead of claiming recovery.

The private stage directory holds `alarms.jsonl` at mode 600. Each changed checkpoint is appended and fsynced before dispatch. It contains machine states, measurement trackers, page claims and a durable outbox. Malformed history or non-private files block reads; the loop never discards history to forget alarms. Preparation failures retain one queued notice per incident/kind. Once prepared, the signed plaintext envelope is persisted before submission. Retries replay that exact envelope, preserving the mailbox's sender-DID/TID idempotency identity. Accepted deliveries are checkpointed individually. An earlier failed delivery blocks later messages to the same recipient, so a late fire cannot follow its own all-clear.

Critical incidents reserve a Joel page slot before attempting the configured gateway script. Warn and recovery messages do not normally page. `wake.unacked` also pages through the same configured gateway when `switchboard` has an overdue wake; recovery never pages. A key cannot reserve another page for six hours; all keys share at most six in a rolling 24-hour window, which is stricter than six per calendar day. Page failure or uncertainty consumes its slot rather than risking duplicate pages. Pages are independent of Rat King delivery, so a broken issuer can still reach Joel. Successful page execution requires exit zero and JSON `ok: true`.

## Configuration

`stage.json` owns all identities, recipients, paths, commands and owner mappings. Add an optional `alarm` section with:

- `enabled`: explicit boolean, initially false.
- `broadcast`: destination agent name for every alarm.
- `musterDesk`: the configured Muster desk name, included for `readers.*`, `issuer.*` and `wake.*`. A firing `readers.stuck` also goes to each stuck reader's owner, named in its heartbeat (`MUSTER_OWNER_NAME`). The all-clear goes to the static recipients only.
- `owners`: key or dotted-prefix to owning desk. The longest matching prefix wins. Recipient fan-out is deduplicated.
- `renotifyMinutes`: optional positive integer, default 120.
- `notify`: operator identity secret, directory path and optional Pi config path. The sender is always `operator`; its identity must match the directory's operator DID.
- `page`: Node executable and the approved notification gateway script path.
- `launchd`: label, Node executable, checkout `source`, PATH and output/error log paths.
- `readerHeartbeats`: one entry per host, with a display `host`, the Pi state's `readers` directory as `dir`, and an `ssh` destination for every host but the alarm's own. The worker reads each host's heartbeats with one bounded call per check (10 seconds, `BatchMode=yes`). Pid liveness is checked on that host. If the list is omitted, reader monitoring is unknown, not healthy. If a host's directory is missing, that host has no readers. The older `readers` list with `aliveCommand` is ignored. It is accepted only so existing configs keep loading, so delete it when you add `readerHeartbeats`.

Optional `alarm.wakeTargets: [{ name, owner, unackedMinutes?, page? }]` monitors named recipients without Pi heartbeats. Names resolve through the same directory path as heartbeat targets and are queried once; configured owners and thresholds win on duplicate names. The positive threshold defaults to 3 minutes and applies with a live, missing or expired lease. Overdue mail fires `wake.unacked` and routes to the configured owner. Paging through the existing operator gateway and budgets is opt-in per target with `page: true`; omitted or false disables paging, except for `switchboard`, which still pages. Evidence names the recipient, waiting seconds and lease state. Heartbeat-only targets retain the live-lease rule.

Use a fresh copy of the live stage config. Do not promote an older proposal that loses approval fields or notification recipients.

## Sources

- `ship.failed`: latest failed receipt; public SHA and sanitized cause. Missing/unreadable receipt history is unknown, not recovery.
- `ship.churn`: warn when more than `ship.restart.churnLimit` (default 3) ship receipts report a celld restart within the last 24 hours. It never blocks a restart. Missing receipt history is unknown.
- `celld.down`: two failed health checks outside a fresh `restarting` marker's 180-second window. The marker is read on the configured live node, not from the alarm host's filesystem. Unknown marker readback cannot prove that a restart window has ended.
- `celld.restarted`: ActiveEnter moves after the initial baseline without a receipt that reports a real restart spanning that instant. It remains firing until an explaining receipt appears. Deploy-time observations wait for receipt/window resolution. A maintenance window run by `celld-window.sh` appends a window receipt (`kind: "window"`, epoch-second `start`/`end`, reason, approval, result, before/after celld PID and ActiveEnterTimestamp) to `window-receipts.jsonl` beside the deploy marker on the live node; the alarm reads it there like the marker, skipping malformed lines; a restart inside `[start, end]` is explained. Window receipts are separate from ship receipts, so the ship judge never reads them. A missing or unreadable window file explains nothing.
- `issuer.broken`: failed or unavailable configuration doctor.
- `readers.stuck`: warn when a heartbeat's pid is alive and its reader has made no lease or consume progress for over 5 minutes. Progress is `lastConsumeOk`, or `startedAt` before the first lease. Evidence names each reader, its host, state, last error tag and idle minutes. A heartbeat whose pid is dead is stale and ignored. An unreadable host makes the reading unknown, unless another host already shows a stuck reader.
- `wake.unacked`: warn when a message declared as wake has remained delivered but unacked for strictly more than 180 seconds and the recipient's lease is still live. It uses the same pure verdict as `ratking health`, independent of reader progress. Targets and owners come from the configured heartbeat files, including dead-reader heartbeats. The operator-only `mailbox.nameHealth` query returns metadata without content or decryption. Broadcast, Muster desk and each affected name's heartbeat owner receive the warning. A newly affected name notifies immediately, even during the reminder window. A stalled `switchboard` also uses the existing configured operator page gateway, under the same six-hour and rolling 24-hour budgets. Ack clears the condition and sends recovery to the remembered incident owners. Missing targets, unknown intent or lease expiry alone do not prove recovery. A complete snapshot with no pending wake clears the incident even if the lease has since expired. Incident targets survive journal round trips and remain queried after their heartbeat disappears. Wake observations use mailbox queries, not process probes or service-control commands. Collection runs four requests at a time under a fifteen-second source deadline.
- `filer.slots`: free/max below 10 percent, critical below 5 percent. Missing values or zero capacity are unknown.
- `quarantine.growth`: more than twenty files with fresh modification times in the preceding hour, summed across both configured quarantine roots. The quarantine-only collector does not read sessions or route receipts.
- `digest.fail`: latest digest is fail, or a source measurement was unavailable. Missing history is unknown.

Source probes have bounded deadlines. The worker targets a 60-second cadence and bounds each cycle at 55 seconds. There are no service-control actions, listener processes or recovery automation in this loop.

## Qualification

Run property/model tests, then `alarm-check` with approved private selectors. Run `alarm-check` and confirm that each configured host's heartbeats are read. The desk should test operator fan-out and the configured Joel gateway under its live-message approval, install the printed plist once, and inspect journal delivery/page claims. Roll back by disabling or unloading this one desk-owned job; no infrastructure or mailbox data rollback is involved.

Untested by this lane: live fan-out, a real Joel page, launchd restart supervision and the ssh path to a remote heartbeat host. The property suite covers lifecycle/restart replay, stable-key dedupe, page budgets, source thresholds, deploy grace and encoded envelope replay. Filesystem quarantine freshness uses modification time, not a claim about file birth time.

## Crash notices: retries, refusals and logs

- A crash notice whose recipient the mailbox refuses as `Retired` or `UnknownName` is terminal. With a successor named in the refusal, the notice is re-sealed to the successor once. Otherwise, or if the successor refuses too, the key moves to `sent` and is recorded under `dropped` with the reason.
- Other send failures back off per entry: 2 s doubling, jittered down by up to half, capped at 10 minutes. The journal's `attempts` and `nextAt` are optional, so older journals read as due now. Only the first failure and the recovery are logged.
- The alarm and ship runners exit for a launchd restart when the ship checkpoint's `successful` sha changes, meaning a commit from `origin/main` was deployed. Commits made in the local checkout do not restart them.
- Once per cycle the worker checks `alarm.out.log` and `alarm.err.log`. Past 16 MiB it gzips the file's current bytes to `<name>.<utc>.log.gz` beside it, fsyncs the archive, and truncates the live file. launchd owns those files and keeps appending through its open descriptor, so renaming would send new output into the archive. Copy then truncate keeps launchd's descriptor valid. Archives older than 30 days are removed. The first rotation after deploy archives the existing large log.
