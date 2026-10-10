# Nest proof stack

This program deploys the mailbox and a hosted agent Durable Object on an inventory-selected host. It composes the user slice, object-store bucket, celld node, CLI and generated mailbox deployment. The node startup guard seeds a deployment pointer before opening listeners. Deployment then replaces that pointer, reloads the internal listener and checks the expected mailbox version and commit through the Worker listener.

Run `node stacks/nest/cli.ts prepare|plan|deploy|backup|restore|restore-snapshot|listeners|stop|destroy-plan|destroy|teardown-probe` with private inputs:

- `RATS_NEST_INSTANCE`, `RAT_KING_LIVE_NODE`, `RAT_KING_STATE_DIR`
- `RAT_KING_STAGE=proof|pilot|fleet` (`proof` is the default)
- `RAT_KING_LOCAL_AGENT`, `RAT_KING_LOCAL_DID`
- `RAT_KING_REMOTE_AGENT`, `RAT_KING_REMOTE_DID`
- `RAT_KING_SERVICE_DID`, `RAT_KING_DOCUMENTS`, `RAT_KING_CLI_OUTPUT`
- `RAT_KING_VERSION`, `RAT_KING_COMMIT`
- `RAT_KING_START_APPROVED=true` for the approved manual deployment
- `ALCHEMY_TELEMETRY_DISABLED=1` on every invocation

Build the CLI first using `apps/mailbox/cli/build.ts`. Preparation installs it and provisions the two private identities on their own machines. Only public DID documents return to the operator. Keys stay outside Alchemy state. This is the proof-only file-custody shortcut described in the CLI README.

For an existing P3 deployment, import its resource-state rows into the private `nest/proof` state namespace **before** evaluating the stack. Preserve resource FQNs, instance IDs and the random credential rows. Keep the old state as recovery evidence, but stop using it to drive the resources. The first plan must show the existing resources unchanged, not replacement or destruction. Do not regenerate the bucket credentials to adopt a running store.

The launcher refuses state inside the public repository, including through a symlink. The plan refuses delete and replace actions. For an explicitly approved teardown, run `destroy-plan`, inspect the resource list, then `destroy` and `teardown-probe`. Destroy drains the bucket before stopping its server, purges owned data children, removes deployment files and the explicitly owned provisioned remote agents directory, and removes empty roots. Purge refuses symlinks and paths outside inventory-owned roots. The probe is read-only and prints only pass/fail labels. A failed probe means stop, report leftovers and retain state; never hand-clean the host. Local operator keys and state retention remain the operator’s responsibility.

## Loopback-only pilot

`RAT_KING_STAGE=pilot` selects a separate `nest/pilot` Alchemy namespace. Give it a fresh private state directory outside the repository and its own isolated Linux VM. Never select an existing proof host for the pilot. The pinned release assets require Linux x86_64; on an ARM host the VM uses amd64 emulation. Install Node 24.18.0 in the VM before preparation. Create the missing user configuration parents (`~/.config`, `~/.config/systemd`, `~/.config/systemd/user`) at mode 700 before deployment; fresh VMs do not have them. Enable lingering for the VM user only so user units return after a VM restart.

OrbStack pilot machines reject transient user scopes with `Inappropriate ioctl for device`. Pilot bootstrap probe jobs therefore use explicit service mode: `systemd-run --user --wait --pipe --collect` with a unique owned service name, the same slice, 64M memory, no swap, 10% CPU, 64 tasks and nice priority 10. The service checks its applied systemd properties before executing the probe; an unreadable or mismatched cap, nonzero exit or timeout fails. Output bounds and credential redaction remain unchanged. Other stages and hosts retain the byte-identical default scope command.

Failed-start cleanup treats a stop failure as harmless only after that exact unit reports `LoadState=not-found`. Other stop failures remain failures. Cleanup failures are logged without replacing the original startup error.

The pilot deploys only the mailbox Worker, Mailbox and AuthTokens Durable Objects. It declares no hosted agent, runtime identity files, sidecar or gateway. It refuses gateway mode or a sidecar. The pilot stage sets every core listener and the generated CLI endpoint to `127.0.0.1`, independently of the inventory node address. Proof retains the inventory tailnet bind and endpoint. Loopback is a stage property, not private inventory data.

For example, an invented private node can use `ssh: "mailbox-example@orb"`, `home: "/home/example"`, `dataRoot: "/home/example/mailbox-data"` and `tailnetIPv4: "203.0.113.10"`. Use the VM\'s actual address for this required compatibility field; pilot does not use it for listening. Keep the inventory mode 600. VM creation might use `orb create --arch amd64 --cpus 2 --memory 2G --disk 16G --isolated ubuntu:noble mailbox-example`. This is an example, not deployment authority.

Additional stage inputs:

- `RAT_KING_OPERATOR_DIDS='["did:web:operator.example.invalid"]'`
- `RAT_KING_LEASE_RESOLVERS='[]'` until the owner supplies resolver DIDs
- `RAT_KING_ISSUER_DID_TEMPLATE='did:web:{agent}.pi.example.invalid'` enables `identity.register`; unset, the Worker gets no issuer template and register answers 503
- `RAT_KING_ISSUER_RESERVED='["switchboard"]'` lists names the issuer refuses; applied only with the template
- `RAT_KING_DOCUMENTS` contains the operator's public DID document, never its private keys
- `RAT_KING_AGENT_MODEL=faux`, `RAT_KING_CLAUDE_SIDECAR=false`
- `RAT_KING_SLICE_MEMORY_MAX=1536M`; pilot slice CPUQuota is 150%, below a 2 CPU / 2 GB VM's limits

`prepare` installs the built CLI and records the VM user's Claude mtimes. It requires pre-existing public documents but does not provision hosted or local proof identities in pilot mode. Mint the operator with the CLI's key code, pipe its JSON into the credential daemon and delete temporary mode-600 key files. CLI custody and provisioning follow the CLI README.

Before deployment, prove that loopback VM ports forward only to host loopback. Inspect OrbStack's host listeners with `lsof -nP -iTCP -sTCP:LISTEN`, and test host LAN, tailnet, VM bridge and VM DNS addresses from another machine. Stop if any answers. Do not change global OrbStack settings or add firewall rules. After deployment, require exact commit/version readback, a no-change plan, the listener gate, encrypted delivery and a VM restart with persisted messages. An offline plan proves none of those live behaviors.

Crypto remains **unreviewed**. This pilot is for the operator's own agents, not public or customer traffic. VM restart survival is not host reboot survival: when OrbStack's `app.start_at_login` is false, open OrbStack after a host reboot before expecting the VM back. Do not change login settings as part of the pilot.

With the same private environment and stage selected:

- **Stop:** `node stacks/nest/cli.ts stop` stops the mailbox user units without deleting messages.
- **Destroy:** first run `node stacks/nest/cli.ts destroy-plan` and inspect the owned resource list. After separate teardown approval, run `node stacks/nest/cli.ts destroy && node stacks/nest/cli.ts teardown-probe`. Retain state and report any failed probe.
- **Delete the example VM:** `orb delete mailbox-example`, only after stage destruction and a passing teardown probe. This is a separate irreversible action.

Rollback redeploys the previous commit with the same stage inputs, or stops the stage. It does not restore data. A stage namespace isolates Alchemy state, not Linux service names; never run proof and pilot against the same VM/user.

## Standing fleet mailbox

`RAT_KING_STAGE=fleet` uses a separate `nest/fleet` namespace. It deploys only the mailbox Worker, Mailbox and AuthTokens Durable Objects. Like pilot, it refuses hosted models and sidecars and never declares runtime files or leases a gateway key. Unlike pilot, its Worker binds the inventory tailnet IPv4 on 18787. The other nine listeners remain loopback. Its slice is fixed at 4G and 200%; a different memory override is refused. Proof and pilot behavior is unchanged.

Supply static public operator documents, operator DIDs and the service DID. `prepare` does not mint or copy client private keys. Client custody stays in the operator's credential daemon. Generated files, inventory and Alchemy state remain private.

Both fleet service units run the same cgroup/address/port gate used by deployment through a bundled `ExecStartPost`. A gate failure queues a nonblocking stop of both units, fails startup and logs the violation. Nonblocking stop avoids waiting for the hook's own start job. Services remain enabled under `default.target` with `Restart=on-failure`; the host owner must have enabled lingering. Reboot survival still requires live proof.

Set `RAT_KING_BACKUP_ROOT` to an approved directory on an **existing CIFS mount**. The backup service runs in `rat-king.slice` with `MemoryHigh=128M` reclaim/throttling and unchanged 256M / 25% / 64-task hard caps. Its user timer runs at 10:00 UTC each day and catches missed runs. The timer is enabled under `default.target`; timers themselves have no process cgroup.

`backup` runs that service. It refuses an absent SMB mount, an inactive mailbox, a symlink or special file in either data directory, and too little local space, all before anything stops. A lock prevents concurrent backups. Arming refuses a missing start timestamp or unit age of 20 minutes or more, and checks age again after marker fsync. The job then stops celld and SeaweedFS, in that order, and requires a clean shutdown of both. It copies `celld/` and `seaweedfs/` to a local staging directory, using a reflink where the filesystem supports one and a bounded-cache copy otherwise. It checks file count, directory count and total bytes against the source. Copy and check have a 20-second budget. It then starts SeaweedFS, waits for its health gate, and starts celld once behind its own gate. The journal records `BACKUP_STOP_MS`. Any failure or interruption in that stopped window restarts SeaweedFS, then celld. A durable restart marker and an independent systemd `ExecStopPost` hook do the same after a worker error, timeout, OOM or SIGKILL. A failed guarded start preserves the marker and fails the backup; no startup gate is bypassed. Publication runs with the mailbox up and never stops or restarts a unit. It writes a streaming gzip-1 tar of the staging copy, runs `gzip -t` on it locally, then copies it to a hidden `.mailbox-publish-*` directory on the mount. The copy hashes every byte it writes. The job syncs a format-4 manifest and atomically renames the directory to its final dated name. It then reads the published archive back over the share, checking size and SHA-256 against the local archive, and runs `gzip -t` on it there. Every share step has its own timeout. The journal records the unit cgroup's `memory.events`, `memory.pressure` and `memory.stat` before the stop and at the start and end of publication. Only after a verified publication does cleanup remove recognized local staging directories, `.rk-backup-mem-<date>.log` files, hidden publication directories and dated partials without a manifest, each containing only names the job writes. Foreign files, symlinks and any dated directory with a manifest are preserved. Complete share backups are never overwritten or deleted; retention is manual. **The archive is a raw copy of both data directories.** It includes the internal peer key and every bucket object. Configuration, S3 credentials, client private keys and Alchemy state live outside the data root and are excluded. Treat the share as secret-bearing. See [the design and qualification limits](BACKUP-DESIGN.md).

`restore-snapshot` requires fleet stage and `RAT_KING_START_APPROVED=true`, and restores in place on the deployed host. While the mailbox serves, it copies the newest format-4 backup to a local directory, checks its SHA-256 and inflates every member, comparing counts and bytes with the manifest. It then stops celld and SeaweedFS. It moves the current `celld/` and `seaweedfs/` into `.mailbox-restore-aside-<timestamp>-<hex>/` and unpacks the snapshot with directories at 700 and files at 600. It checks counts and bytes again, then starts SeaweedFS and celld. If unpacking fails, the partial tree moves aside as `partial-*` and the previous directories come back before the units restart. The command then runs the exact-listener gate. The aside directory is never deleted automatically.

`restore` is the legacy fresh-target path for format-2 and format-3 logical backups. It refuses to run when the newest complete backup is a format-4 snapshot. requires `RAT_KING_START_APPROVED=true`, a prepared operator state directory and a fresh target with an empty data root and stopped units. Its read-only preflight selects the newest complete format-2 or format-3 backup on the mounted share and validates both hashes and all archive paths without creating data directories. Deployment first creates and records ownership of the mode-700 directories. The celld pre-start hook then extracts the pinned snapshot into the empty owned celld directory while celld remains stopped. Extraction sets directories to 700 and files to 600 explicitly, regardless of umask, and asserts the celld directory's mode. The existing purge-adoption guard is unchanged. A fresh Alchemy namespace/state mints fresh internal S3 credentials and rewires celld; never import the source namespace's random credential rows. Before celld starts, the startup provider imports and reads back every exported object using those fresh credentials. It accepts old format-2 uncompressed pairs and new format-3 gzip pairs, including indexed and streaming object archives, and validates the entire object archive before the first write and removes only the local import archive after successful import. Celld regenerates its excluded peer-auth key. This is safe for the single-node mailbox; it is not a multi-node peer-key rotation procedure. Public registrations and encrypted messages are part of the restored data. Client keys stay with clients. The command refuses an occupied data root rather than deleting or overwriting it. Partial extraction leaves data in place for operator inspection and refuses an automatic retry.

Do not deploy, stop or destroy concurrently with a backup. Before any live change, notify the host owner. A drill or teardown needs its own approval. Capture the backup directory, file count and bytes before teardown and after restore; they must match. Destroy never receives the backup root as a purge root. After the teardown probe, wait for the host owner's clean verdict before restore. Before cutover, require a previously registered recipient to decrypt a message sent before the backup, without re-registering that identity. A backup completion or successful deployment alone proves none of this.

`health` is a read-only digest of the deployed host. It prints one JSON object on stdout and a one-line summary on stderr. It reads both units' state, restart count and start time; the tailnet health status and latency; the stack listener count against the exact-listener gate; free and max volume slots and the storage alarm (`storage-maintenance.py diagnose`); the bucket collection's file, delete and byte totals from the master's `/vol/status`; both data directory sizes; the last backup run's result, times, `BACKUP_STOP_MS` and `MemoryPeak`; the newest complete share backup and the next timer run; and the last retention run. It never stops, starts, writes or deletes anything on the host, and it lists neither the filer nor an archive. The host kills each command after 20 seconds and the client gives up after 30, so a hung mount or service nulls only its own field and names it under `unavailable`. `status` is `fail` when health is not 200, a unit is not active, the listener count misses the gate, the storage alarm is set, or the newest complete backup is more than 36 hours old or missing. It is `warn` for a unit restart outside the last backup run, a failed last backup run, a stop over 60 seconds, free slots under 25 percent, an unreadable field, or an object count more than three times that of `--previous <file>`, a prior digest. The command keeps no state of its own.

The cheapest unauthenticated celld health path is `/.well-known/celld/health` on the tailnet Worker listener. Code rollback redeploys the previous known-good version; it does not restore arbitrary data. Backup/restore is an explicit data operation, not rollback.

Untested until live qualification: SMB failure during publication, disk exhaustion, interrupted shutdown/extraction, host reboot, migration to a different Linux host, registered-identity preservation and recipient decrypt after restore.

## Recover lost local state

For mailbox-only stages, set `RAT_KING_RECOVER_STATE=true` and select a fresh external `RAT_KING_STATE_DIR`. Keep the original stage, inventory, public documents, bundles and deployed version/commit. Notify the host owner, then run `plan` only. Never move or overwrite the real `.alchemy` directory to test recovery.

The pinned Alchemy beta.80 reports cold owned resources as `adopted`. Dependencies show `create` with `deferredAdoption` until apply can resolve their inputs and run the same provider read. The plan log labels those rows `deferred-adoption`. Exactly two plain creates are expected: the store's Random access and secret keys. Any other plain create, delete or replace fails recovery qualification. A read-only plan cannot prove the deferred reads will succeed.

Matching files, pinned binaries and exact unit content prove ownership inside the inventory's mode-700 roots. Credential rotation validates the existing generated configuration on the host without recovering its secret values. Recovery deliberately mints new keys, rewrites the store and celld credential files, and restarts both units behind the existing startup gate. Existing deployment bytes and live version must match. Foreign content refuses, including with explicit adoption enabled. Hosted runtime custody recovery is not supported.

Recovery keeps directory and bucket purge disabled; keep the recovery flag on afterwards. Restoring purge authority requires a separate explicit operator action and is outside this procedure.

An apply needs separate startup approval. After an approved recovery apply, require a literal noop plan, the listener gate and recipient-level encrypted delivery. Do not recover by copying old Alchemy state or old credential rows. Recovery changes credentials, not application data; rollback of code does not restore either.

## Hosted agent and optional Claude sidecar

The default is `RAT_KING_AGENT_MODEL=faux`: no gateway origin or credential enters generated Worker configuration, and no sidecar is declared. The hosted DID is `RAT_KING_REMOTE_DID`; its private identity stays in the existing remote mode-600 file-custody shortcut (door 3). Preparation records the user's `.claude*` and `.local/bin/claude` mtimes in private operator state before writing any deployment files. Use a fresh state directory; preparation refuses to overwrite that snapshot.

Gateway inputs, kept on the private side:

- `RAT_KING_AGENT_MODEL=gateway`
- `MODEL_GATEWAY_BASE_URL`, with a `/v1` path
- `RAT_KING_MODEL_GATEWAY_SECRET_NAME`, the target credential daemon's private entry name
- `MODEL_GATEWAY_MODEL=gpt-6-sol` or `claude-opus-5-5`
- `RAT_KING_CLAUDE_SIDECAR=true` and `RAT_KING_SIDECAR_OUTPUT` for Opus
- `RAT_KING_SLICE_MEMORY_MAX=5632M` for the separately approved sidecar run. CPUQuota remains 300%. The default memory cap remains 4G.

Build both operator artifacts before planning:

```sh
node apps/mailbox/cli/build.ts
node apps/claude-sidecar/src/build.ts
```

The sidecar bundle includes the SDK and bridge runtime. The dedicated Claude Code executable is downloaded on the target, not bundled. The provider checks version 2.1.285 and the linux-x64 release checksum from `manifest.json`, refuses a changed existing executable, and installs mode 755 under `.local/share/rat-king/claude-code/2.1.285/claude`. It never runs npm, sudo or the general installer. The user unit runs `/usr/local/bin/node`, with 1536M / 100% caps, control-group kill, no-new-privileges and a mode-600 unquoted `EnvironmentFile`. It binds only `127.0.0.1:18789`. Its private config and temp directories stay under `.local/share/rat-king/claude-sidecar/`; cleanup uses Node filesystem APIs, not a `trash` executable.

Every Claude Code query passes the exact SDK option **`tools: [],`** in `apps/claude-sidecar/src/sdk-adapter.ts`. The hosted harness has an empty tool registry, so its requests also declare no MCP tools. The sidecar retains MCP handoff support for separate proofs; this stack gives it none.

### Remote binding custody

`AgentRuntimeFiles` runs `secrets --no-update-check lease <private-name> --ttl 1h --client-id rat-king-s6` on the target at initial deployment. It writes the gateway key, endpoint, sidecar bearer and binding JSON at mode 600 under `.config/rat-king/agent-runtime/`. Neither the gateway credential nor private agent JWKs return to the operator or enter Alchemy state. State records public generated configuration and remote paths only; the endpoint and host inventory remain private inputs.

Pinned celld v0.6.1 **deploy does not read `.dev.vars`** (`crates/celld/deploy.rs:205`). The Deployment provider therefore generates the final mode-600 `wrangler.json` on the target by merging its public configuration with the binding file. Readback compares `wrangler.public.json`, never the secret-bearing generated file. celld stores the merged configuration in the owned object store; that store is private and is purged on destroy. This is a proof shortcut, not production key custody or encrypted object-store configuration.

### Listener contract

Startup checks intermediate resource stages, then the final deployment requires exactly eleven owned listeners with the sidecar:

- `127.0.0.1`: 19333, 18081, 18888, 18333, 29333, 28081, 28888, 28333 (SeaweedFS)
- `127.0.0.1:18788` (celld operator)
- `127.0.0.1:18789` (sidecar)
- inventory tailnet IPv4, port 18787 (celld Worker)

The gate checks process, interface and port, including any extra listener owned by the sidecar PID. The sidecar's `node` or Linux `MainThread` label is accepted only when every listed PID equals the unit's `MainPID` and its `/proc/<pid>/exe` resolves to the approved `/usr/local/bin/node` target. A mismatch stops the core units and the active sidecar before returning failure. Faux mode expects the ten core listeners. The owner must reconcile this exact list and approve the guard before live startup. Weed readiness has a bounded 30-second wait for missing listeners, checking every sample immediately for extras; this covers persisted-store Raft election before filer and S3 bind.

### Two model turns, one hosted DID

Model selection is per hosted-agent configuration, not message content. Deploy Sol first. From the operator's mailbox CLI, send one encrypted question, list the operator's mailbox and open the returned envelope. Require `verified: true`, the hosted DID as sender and `replyTo` matching the send receipt. Check that the original reached `acked` using the target's existing mailbox CLI. Then set `MODEL_GATEWAY_MODEL=claude-opus-5-5`, plan and deploy/reload the same DID, and repeat once. Do not retry a failed model attempt.

pi-durable preserves its root model across reopen. For this hosted configuration only, the adapter refuses a model change while tasks or submissions are unfinished. When idle, it inserts a context reset and configures the new model. This prevents the sidecar from importing Sol's prior history while preserving mailbox journals and submission IDs.

```sh
node "$RAT_KING_CLI_OUTPUT" send --from "$RAT_KING_LOCAL_AGENT" --to "$RAT_KING_REMOTE_DID" --body 'What is 2 + 2? Answer in one short line.'
node "$RAT_KING_CLI_OUTPUT" list --as "$RAT_KING_LOCAL_AGENT"
node "$RAT_KING_CLI_OUTPUT" open --as "$RAT_KING_LOCAL_AGENT" --file /path/to/private/reply-envelope.json
```

Extract the reply event's `envelope` to a mode-600 private file for `open`. Keep endpoint, documents, service DID and keys in the CLI's private environment. Complete each model's reply and ack before changing configuration. A fallback requires destroy first, then a fresh faux configuration; it is not a hot mode switch.

Destroy reverses the resource graph: deployment, sidecar unit, runtime custody/install, celld, storage and slice. Runtime custody deletion also deletes the matching declared sidecar unit when an interrupted create left no completed unit state. Unit deletion disables the unit, removes its matching default-target wants link and file, then reloads the manager. Weed deletion removes only its two owned, non-listening S3 Unix sockets after stop. It also removes the explicitly owned remote proof-key directory. The read-only teardown probe checks port 18789, the dedicated install's absence and unchanged user Claude mtimes, in addition to the original checks. Never hand-clean a leftover.

### Interrupted-delete recovery

Only with explicit owner approval, `recover-delete` calls the same provider delete helper for the matching sidecar unit and cleans the two owned, non-listening S3 sockets. It never starts services, reads credentials or evaluates the deployment stack. Run the full `teardown-probe` afterwards. A changed unit, foreign wants link, active socket or non-socket path refuses cleanup; never hand-clean a leftover.

### Offline qualification

`RAT_KING_OFFLINE_PLAN=true` selects the in-memory HostShell. The launcher permits **plan only** with this switch. Supply an invented mode-600 inventory and fresh external state; no SSH connection is constructed. This checks graph construction and generated bundles, not target readiness.

Not tested: Linux deploy, real remote lease, guard enforcement, live listener readback, both real model round trips, zero-diff live plan, live destroy, teardown mtimes, cgroup behavior, interruption recovery, credential rotation or sustained load. Phase A grants no host-contact or deployment authority.

After deployment, confirm version readback, a no-change plan and the listener probe. The remote CLI uses `$HOME/.config/rat-king/proof.env`. Source it before running `node "$HOME/.local/share/rat-king/bin/mailbox.mjs"` commands. See the CLI README for list, open, lease and ack.
