# Fleet alarms

`alarm` launches one lock-owning Effect worker through macOS `lockf`. `alarm-plist` prints its launchd declaration. The desk installs it; this lane does not install, enable or send live messages. Configuration must explicitly set `alarm.enabled: true` to run. `alarm-check` reads and prints sanitized source conditions without writing alarm state or sending notifications.

## Lifecycle and delivery

One XState machine per stable key holds `ok`, `firing` and `recovered`. SHA changes, different diagnostic text and repeated known failures do not create new keys. A key sends on entry, a severity increase or the reminder interval (default 120 minutes). Recovery sends once with incident duration. Unknown measurements retain the previous alarm instead of claiming recovery.

The private stage directory holds `alarms.jsonl` at mode 600. Each changed checkpoint is appended and fsynced before dispatch. It contains machine states, measurement trackers, page claims and a durable outbox. Malformed history or non-private files block reads; the loop never discards history to forget alarms. Preparation failures retain one queued notice per incident/kind. Once prepared, the signed plaintext envelope is persisted before submission. Retries replay that exact envelope, preserving the mailbox's sender-DID/TID idempotency identity. Accepted deliveries are checkpointed individually. An earlier failed delivery blocks later messages to the same recipient, so a late fire cannot follow its own all-clear.

Critical incidents reserve a Joel page slot before attempting the configured gateway script. Warn and recovery messages never page. A key cannot reserve another page for six hours; all keys share at most six in a rolling 24-hour window, which is stricter than six per calendar day. Page failure or uncertainty consumes its slot rather than risking duplicate pages. Pages are independent of Rat King delivery, so a broken issuer can still reach Joel. Successful page execution requires exit zero and JSON `ok: true`.

## Configuration

`stage.json` owns all identities, recipients, paths, commands and owner mappings. Add an optional `alarm` section with:

- `enabled`: explicit boolean, initially false.
- `broadcast`: destination agent name for every alarm.
- `musterDesk`: the configured Muster desk name, included for `readers.*` and `issuer.*`.
- `owners`: key or dotted-prefix to owning desk. The longest matching prefix wins. Recipient fan-out is deduplicated.
- `renotifyMinutes`: optional positive integer, default 120.
- `notify`: operator identity secret, directory path and optional Pi config path. The sender is always `operator`; its identity must match the directory's operator DID.
- `page`: Node executable and the approved notification gateway script path.
- `launchd`: label, Node executable, checkout `source`, PATH and output/error log paths.
- `readers`: names to monitor and an `aliveCommand` for each. The command must return JSON `{ "alive": true | false }` based on positive evidence of that specific Pi process. Do not substitute an existing pane, directory entry or network ping. Unknown/failed probes do not establish absence. An empty list means reader monitoring is unknown, not healthy.

Use a fresh copy of the live stage config. Do not promote an older proposal that loses approval fields or notification recipients.

## Sources

- `ship.failed`: latest failed receipt; public SHA and sanitized cause. Missing/unreadable receipt history is unknown, not recovery.
- `celld.down`: two failed health checks outside a fresh `restarting` marker's 180-second window. The marker is read on the configured live node, not from the alarm host's filesystem. Unknown marker readback cannot prove that a restart window has ended.
- `celld.restarted`: ActiveEnter moves after the initial baseline without a receipt that reports a real restart spanning that instant. It remains firing until an explaining receipt appears. Deploy-time observations wait for receipt/window resolution.
- `issuer.broken`: failed or unavailable configuration doctor.
- `readers.stuck`: a configured Pi is positively alive and its resolved lease is absent/expired for at least ten minutes. Unknown checks reset the absence proof; they do not clear a firing key.
- `filer.slots`: free/max below 10 percent, critical below 5 percent. Missing values or zero capacity are unknown.
- `quarantine.growth`: more than twenty files with fresh modification times in the preceding hour, summed across both configured quarantine roots. The quarantine-only collector does not read sessions or route receipts.
- `digest.fail`: latest digest is fail, or a source measurement was unavailable. Missing history is unknown.

Source probes have bounded deadlines. The worker targets a 60-second cadence and bounds each cycle at 55 seconds. There are no service-control actions, listener processes or recovery automation in this loop.

## Qualification

Run property/model tests, then `alarm-check` with approved private selectors. Verify every reader's Pi-alive command separately before enablement. The desk should test operator fan-out and the configured Joel gateway under its live-message approval, install the printed plist once, and inspect journal delivery/page claims. Roll back by disabling or unloading this one desk-owned job; no infrastructure or mailbox data rollback is involved.

Untested by this lane: live fan-out, a real Joel page, launchd restart supervision, and each operator-supplied Pi-alive probe. The property suite covers lifecycle/restart replay, stable-key dedupe, page budgets, source thresholds, deploy grace and encoded envelope replay. Filesystem quarantine freshness uses modification time, not a claim about file birth time.
