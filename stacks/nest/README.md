# Nest proof stack

This program deploys the mailbox and a hosted agent Durable Object on an inventory-selected host. It composes the user slice, object-store bucket, celld node, CLI and generated mailbox deployment. The node startup guard seeds a deployment pointer before opening listeners. Deployment then replaces that pointer, reloads the internal listener and checks the expected mailbox version and commit through the Worker listener.

Run `node stacks/nest/cli.ts prepare|plan|deploy|listeners|stop|destroy-plan|destroy|teardown-probe` with private inputs:

- `RATS_NEST_INSTANCE`, `RAT_KING_LIVE_NODE`, `RAT_KING_STATE_DIR`
- `RAT_KING_STAGE=proof|pilot` (`proof` is the default)
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

`RAT_KING_STAGE=pilot` selects a separate `nest/pilot` Alchemy namespace. Give it a fresh private state directory outside the repository and its own isolated Linux VM. Never select an existing proof host for the pilot. The pinned release assets require Linux x86_64; on an ARM host the VM uses amd64 emulation. Install Node 24.18.0 in the VM before preparation. Enable lingering for the VM user only so user units return after a VM restart.

The pilot deploys only the mailbox Worker, Mailbox and AuthTokens Durable Objects. It declares no hosted agent, runtime identity files, sidecar or gateway. It refuses gateway mode or a sidecar. The pilot stage sets every core listener and the generated CLI endpoint to `127.0.0.1`, independently of the inventory node address. Proof retains the inventory tailnet bind and endpoint. Loopback is a stage property, not private inventory data.

For example, an invented private node can use `ssh: "mailbox-example@orb"`, `home: "/home/example"`, `dataRoot: "/home/example/mailbox-data"` and `tailnetIPv4: "203.0.113.10"`. Use the VM\'s actual address for this required compatibility field; pilot does not use it for listening. Keep the inventory mode 600. VM creation might use `orb create --arch amd64 --cpus 2 --memory 2G --disk 16G --isolated ubuntu:noble mailbox-example`. This is an example, not deployment authority.

Additional stage inputs:

- `RAT_KING_OPERATOR_DIDS='["did:web:operator.example.invalid"]'`
- `RAT_KING_LEASE_RESOLVERS='[]'` until the owner supplies resolver DIDs
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
