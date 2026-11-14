# Alchemy Nest

Alchemy v2 providers for Linux hosts over SSH. They run as a non-root user. `SystemdUnit` accepts user scope only; it never calls sudo or the system manager.

## Ports and layers

- `RatsNest.Host` loads the private inventory through `RatsNest.layer`. `node(alias)` returns `ssh`, `tailnetIPv4`, `home` and `dataRoot`. The inventory defaults to `~/.config/rats-nest/instance.json`; `RATS_NEST_INSTANCE` overrides it. Missing, malformed or non-600 inventory fails closed. Legacy inventory without `nodes` still loads, but cannot resolve a node.
- `HostShell` owns remote filesystem operations and command execution. `Ssh.layer(node)` uses the system SSH binary with batch mode, strict host-key checking, a connection timeout and an interruptible command timeout. Supply Node platform services to the layer.
- `ReleaseSource` owns downloads. `sourceLayer` needs an Effect HTTP client. Tests replace both ports with in-memory implementations.
- `providers()` registers all four resources. Individual provider layers are exported too. Each provider layer captures its host shell; use separate stack namespaces and state for separate hosts.

Keep host facts and Alchemy state outside this repository. Pass runtime inventory values to declarations. Real secret files use `contentFrom`, never inline values or `Redacted` props. Alchemy beta.83 encodes the inner value of `Redacted` in state. `Redacted` protects in-memory display, not persistence. Keep external state in an owner-only directory.

## Resources

| Resource | Inputs | Behavior |
| --- | --- | --- |
| `SystemdUnit` | `scope: "user"`, `home`, `name`, `sections`, optional `enabled`, `started`, `restartOn` | Writes under the supplied home's `.config/systemd/user/`. Renders ordered section/key/value pairs, including repeated directives. Supports `.service` and `.slice`. An Install section defaults enablement on; slices without one stay static. |
| `RemoteFile` | Absolute `path`, exactly one of `content` or `contentFrom`, optional numeric `mode` | Atomic write and digest/mode readback. Mode-only updates use chmod. Secret references and legacy Redacted content require mode `0o600`. |
| `HostDirectory` | Absolute `path`, optional numeric `mode` | Creates one directory, not its parents. Defaults to rmdir and refuses nonempty directories. Explicit `purgeOnDelete: true` needs a `purgeRoot` from the shell's inventory-derived owned roots. |
| `ReleaseBinary` | Absolute `path`, GitHub release `url`, mandatory archive `sha256` and `size`, `asset`, optional numeric `mode` | Verifies the download before any installation. Raw assets use `{ format: "raw" }`. Gzip tar assets use `{ format: "tar.gz", member, memberSha256, root? }`. Standalone gzip uses `{ format: "gz", memberSha256 }`. Verifies the expanded binary too. Default mode is `0o755`. |

The tar reader refuses traversal, links, duplicate names, unexpected entry types and malformed headers. A wrapper directory needs an explicit `root`. Downloads are bounded by the pinned size, at most 256 MiB; decompression is bounded at 512 MiB. No SSH library or archive dependency is added.

Directory parents must exist. For Alchemy dependencies, compose paths with `Output.interpolate`, not JavaScript string coercion. Bind a binary's path into the unit that runs it.

## Lifecycle

Alchemy owns create, update, replacement, adoption and deletion. These adapters perform one sequential reconcile rather than starting another background lifecycle.

```text
absent -> write -> daemon-reload -> enable -> start -> readback
present + unchanged -> readback (no write or restart)
present + changed -> write -> daemon-reload -> restart -> readback
matching + explicit adoption -> readback (same running process)
delete -> stop -> disable -> remove file -> daemon-reload
```

A unit restarts only for changed unit bytes, changed `restartOn` digests, a previous incomplete update or the manager's reload flag. A failed create cleans up its unit. A failed update retains the previous applied digest so the next reconcile retries the restart. The inactive implicit slice that systemd synthesizes without a fragment may receive its first declared file. A foreign fragment, a masked unit or an active unit without its declared file is refused.

Existing resources read as `Unowned`; adoption needs Alchemy's explicit adopt policy. Units and binaries must match the declared bytes before adoption. Unit identity changes use delete-first replacement, with the target checked before deleting the old unit. Other path changes replace the resource. Ordinary directory deletion never removes undeclared data. Opted-in data-directory purge stays strictly below an inventory-derived root, refuses symlinks and uses Python's fd-safe deletion. Adoption cannot give an existing directory or bucket purge authority.

## Object storage and cell nodes

`ObjectStore.Bucket(id, { credentials: { accessKey, secretKey }, host, name, slice, purgeOnDelete? })` takes two names from the `agent-secrets` store. It composes the pinned SeaweedFS 4.48 binary, a reference-rendered mode-600 identity file, owned directories and a user service. Its final bucket resource creates a non-versioned bucket through signed S3 requests. Outputs include `endpoint`, `bucketName`, `region` and a discriminated `credentials` descriptor. Reference mode carries names, not credential values.

The deprecated `legacyRandomCredentials: true` option preserves the existing `access-key` and `secret-key` Random resources and their inline Redacted file props. It cannot be combined with credential references. Omitting both options fails closed. Existing stacks select legacy mode explicitly until the desk switches them.

The fleet reads both names from the private inventory's optional `s3Credentials` object, with `accessKey` and `secretKey` fields. Public code has no name defaults. Once reference mode is selected, missing names fail with `InventoryError`; they never select legacy mode. Keep these names in the inventory's `secretNames` publication-fence list too. `SecretSource.layer` leases them on the stack runner with `secrets lease <name> --ttl 5m`. Provide Node process services and this layer when constructing reference-mode file providers. Providers capture the source at construction. Tests use `SecretSource.fromRecord`.

`contentFrom: { secret: name }` installs one secret verbatim. The template form is `{ format, secrets: { KEY: name }, template }`. Placeholders use `{{KEY}}`; rendering substitutes each placeholder once. `format: "json"` inserts a complete JSON string literal, `"environment"` inserts a quoted systemd environment value, and `"text"` or no format inserts text verbatim. Keep literal credentials out of the template. Props contain names and literal template text; attributes contain names, mode, path and the rendered sha256, never the rendered secret text.

A changed value under the same name plans an update by sha. Changing the content source also updates state metadata, even when the bytes match, because Alchemy's noop path retains old props. A same-sha source change exposes stable digest attributes to dependents and writes nothing. See [the switch and rotation procedure](../../stacks/nest/SECRET-REFERENCES.md).

Declare `ObjectStore.Slice(host.home)` once per stack. Pass its `sha256` output to each bucket's `slice` input. The user slice caps aggregate memory, swap, CPU and tasks. SeaweedFS binds its eight fixed listeners to loopback, disables master telemetry, clears the Sentry DSN and disables the OTEL SDK. It explicitly sets `-s3.port.iceberg=0` and `-s3.port.lance=0`: pinned 4.48 `weed/command/server.go:170–171` documents zero as disabled; `weed/command/s3.go:401–408` guards both startup paths.

`Celld.Node(id, { host, bucket, purgeOnDelete? })` composes celld v0.6.1, a mode-600 environment file and a `Celld.Node` user-unit resource. Register `ObjectStore.providers()` and `Celld.providers()`. Outputs are `publicUrl`, `internalUrl`, `version` and the unit attributes. The public listener uses the inventory's address; the internal listener stays on loopback. Credentials never enter unit text. Telemetry is disabled.

`CELLD_TEST_DATA_DIR` is celld's production data-directory knob despite its name.

`Celld.Node` and `ObjectStore.Bucket` accept optional `memoryMax`, `cpuQuota` and `oomPolicy` service settings. Their memory/CPU defaults remain `3G`/`200%` and `2G`/`100%`, respectively. Set `oomPolicy` on each service, not on `ObjectStore.Slice`.

The node uses systemd's default `Type=simple`: an active unit is not a health proof. celld v0.6.1 binds listeners before waiting for a deployment pointer, so open sockets are not an application health proof. The live node lifecycle checks pointer existence and seeds the approved fixed-body bootstrap only if it is absent, then starts the node. The bootstrap probe publishes the fixed-body module fixture with a generated temporary `no_bundle` configuration; it leaves the deployment pointer for the next application to replace. A successful version response without the version schema means the application is not installed yet. Deployment reads report absence, reconciliation installs the real bundle, and destroy recovery leaves exact path cleanup to the custody-checked resources. Transport errors, non-200 responses and a real but mismatched version identity remain failures.

Storage retention treats a 404 on the first metadata-log root listing as no log days and still runs diagnostics. Missing later pages or delete targets, other HTTP errors and connection failures remain alarms. Existing-root retention and the storage health threshold of eight free slots are unchanged. The shared diagnostic reads `/dir/status` for free slots and writable IDs, then `/vol/status` only for matching default-volume presence. It alarms when free slots are below eight or when matching default volumes exist but none is writable. An empty default layout is not evidence of a volume. Both reads share the no-proxy, no-redirect and 8 MiB response limit; failed or malformed volume status reports `diagnosticUnavailable` and an alarm. The five JSON fields and their order stay unchanged. A fresh store with room to grow is healthy and prints a soft stderr warning. Shared script bytes change on the mailbox’s own deployment, never as a side effect of a named deployment.

Named maintenance scripts have no baked master or filer target. Their `retain` and `diagnose` commands require `--instance`, `--master`, `--filer` and `--root`; units render those flags from the layout. The root must be `/topics/.system/log`, and targets must be explicit loopback HTTP endpoints. Named invocations refuse every mailbox listener port unless `--instance rat-king` is explicit. Named retention uses `Restart=no` and leaves retries to its hourly timer. The explicit-target change leaves legacy default units unchanged.

The exported pure `renderMaintenanceScript(host, instanceProps)` returns `{ path, text }`, exactly as written by deployment. It shares the retention and diagnostic implementation with the legacy script, without first-match replacement. Named script and unit rendering rejects literal mailbox filer/master ports before producing output. The SeaweedFS identity name also follows the instance name; the default remains `rat-king`.

Opt-in purge drains paginated bucket objects before DeleteBucket. Alchemy dependencies then stop the store and remove its dedicated data directory. The node stops before its work directory is purged. The proof stack opts in; normal resource declarations do not. Never run destroy without separate authorization.

The live provider layer installs `UnitStartup` checks in both SystemdUnit and Celld.Node create/update reconciliation. Only missing allowed sockets may wait for up to ten seconds; any extra port, wrong process or wrong bind stops both units immediately and fails the reconcile. Store startup requires its exact eight ports; node startup requires the final ten. No diagnose runs before that gate. Probe diagnostics retain at most 16 KiB of stderr, redact generated credentials and host facts, and drain the stream.

`Celld.Deployment` accepts optional `secretNames: readonly string[]`. Omit it to keep the mailbox allowlist: `AGENT_IDENTITIES_CREDENTIAL`, `MODEL_GATEWAY_CREDENTIAL` and `CLAUDE_SIDECAR_CREDENTIAL`. Custom deployments supply their own names; binding generation still refuses undeclared names and collisions with public vars. For named staging, pass the layout and the config-root resource output: `stageDeploymentFiles(host.home, prepared, mailboxOnly, cells.layout, bucket.configuration)`. The fifth argument orders fresh staging after its config root; omitting it keeps the older declaration-only API and does not establish that dependency. Named files stay under `${cells.layout.configuration}/deployment` with instance-scoped resource ids. Omitting the layout preserves the mailbox paths and ids.

## Live probes

The `live` package script requires `RAT_KING_LIVE_NODE` and an external `RAT_KING_STATE_DIR`. It validates the private inventory and disables Alchemy telemetry. Commands are `preflight`, `plan`, `deploy`, `bootstrap`, `bootstrap-check`, `diagnose`, `race`, `store-listeners`, `listeners`, `status`, `uid-probe` and `health`. The store-only listener check covers the interval while the node waits for its first deployment. `deploy` also requires `RAT_KING_START_APPROVED=true`; `race` requires `RAT_KING_RACE_APPROVED=true`. Those switches record an already-granted owner approval, not permission to start a shared-host workload.

The diagnose and race probes run in transient user scopes inside the same slice with a 64 MiB memory cap, no swap, 10% CPU, 64 tasks and nice level 10 through a nice wrapper, not an invalid scope property. The race issues exactly 50 simultaneous conditional creates for a fresh key, requires one HTTP 200 and 49 HTTP 412s, and deletes the key even on failure. A failed conformance probe stops the proof; it does not select another store.

Run `pnpm --filter @rat-king/alchemy-nest live <command>` with those environment variables set. The normal test command never invokes these probes. Preserve the external state directory for the next packet.

## Named-instance rollback proof

The desk runs `test/live/instance-probe.ts`; the normal test suite never invokes it. It creates only `mischiefrb`, with ports 28010–28019 bound to `127.0.0.1`, including the public listener. The host comes from the same private inventory as the nest stack. Supply a fresh, instance-specific data root and a dedicated external state directory. Their parents must already exist.

Run these commands from the repository root. The input variables below refer to private operator values, not checked-in configuration. Set the approval switches only for the approved proof actions.

```sh
export ALCHEMY_TELEMETRY_DISABLED=1
export RATS_NEST_INSTANCE="${PRIVATE_INVENTORY_FILE:?}"
export RAT_KING_LIVE_NODE="${PRIVATE_NODE_ALIAS:?}"
export RAT_KING_PROBE_DATA_ROOT="${APPROVED_PROBE_DATA_ROOT:?}"
export RAT_KING_STATE_DIR="${PRIVATE_PROBE_STATE_DIR:?}"
node packages/alchemy-nest/test/live/instance-probe.ts plan
RAT_KING_START_APPROVED=true node packages/alchemy-nest/test/live/instance-probe.ts deploy
node packages/alchemy-nest/test/live/instance-probe.ts health
node packages/alchemy-nest/test/live/instance-probe.ts destroy-plan
RAT_KING_DESTROY_APPROVED=true node packages/alchemy-nest/test/live/instance-probe.ts destroy
node packages/alchemy-nest/test/live/instance-probe.ts verify-gone
```

`node packages/alchemy-nest/test/live/instance-probe.ts render-units` prints JSON `{ path, text }` entries for the five probe systemd files. It reads the private inventory and data-root configuration but does not connect, download, create state, read a baseline or require start/destroy approval. Save the output outside the public repository. The exported pure `renderUnits(host, instanceProps, limits)` uses the same slice, celld, seaweed and retention declarations and the same unit renderer as deployment. Per-unit `celld`, `seaweed` and `slice` limits are optional; restart-gate selection belongs to the celld/seaweed options. Named instances include the restart gate by default; default instances retain their original ungated default.

Inspect `destroy-plan` before running `destroy`. The stack uses the existing unit cleanup, bucket drain and guarded data-child purge. Named delete custody permits only the layout's exact files, directories, units, deployment directory and store ports. Default delete authority stays unchanged. Named data roots cannot overlap the mailbox data root or the user's configuration/binary trees.

With `purgeOnDelete: false`, a nonempty bucket refuses destruction without deleting its objects. Independent resources may still be deleted, including an empty celld directory through non-recursive `rmdir`. Nonempty journals are not purged. S3 drain alone is not enough; celld journals in `celld/data` must be exported and moved off too, or the directory delete refuses. A refused teardown has already stopped and removed `celld/node`: the service is gone while nonempty journal data stays. Export the evidence first. Record the external archive and drain before retrying destroy against the same retained state.

Named bootstrap cleanup admits only `${configuration}/bootstrap-<lowercase UUIDv4>` and its `index.js` and `wrangler.json`. UUIDs must have version 4 and the RFC variant. Config-root deletion discovers these leftovers, refuses symlinks and unknown children, removes only the two known files, then uses non-recursive `rmdir`. Other entries remain untouched and prevent config-root removal. Interrupted deployments can resume or destroy with the original external state and baseline.

Create-time cleanup audit:

- `instance-probes.ts`: removes the bootstrap `index.js` and `wrangler.json`, then removes their UUIDv4 directory.
- `instance-startup-contract.ts`: removes only `${dataRoot}/.mailbox-restore-objects.tar` after successful import. Named restores reject any other archive before archive stat or import.
- `ssh.ts`: atomic writes trap-remove only the temporary file assigned by that write's `mktemp`. This does not grant generic delete authority over temporary-file prefixes.
- `unit-cleanup.ts`: store socket cleanup uses the layout's exact S3 socket ports and owned store unit. Wants-link removal runs only during teardown and checks the exact owned unit target.
- `files.ts`: direct file removal and directory `rmdir` are resource deletion, not startup cleanup. Named wrappers retain their exact custody checks. The separate default probe and startup modules remain unchanged.

The offline deployment test installs the real startup layer and a custody-enabled fake shell. It exercises bootstrap and restore cleanup, then destroys generated leftover bootstrap directories containing any subset of the two known files. A separate property executes the actual discovery script against local filesystem entries, including symlinks and unknown children.

Before the first deploy, the launcher records both mailbox units' active MainPIDs in a mode-600 file in the external state directory. It never replaces that baseline on a retry. A different host, root or mailbox PID refuses the retry.

`health` checks celld health, the probe worker identity and all ten loopback listeners over SSH. `verify-gone` runs a read-only teardown probe over SSH. It checks `systemctl --user list-unit-files 'mischiefrb-*'`, loaded units, `mischiefrb.slice`, wants links, `ss -ltn` for every port in 28010–28019, both SeaweedFS sockets, and the configuration, staging, binary and data directories. It requires `rat-king-celld.service` and `rat-king-seaweedfs.service` to remain active with the MainPIDs captured before deploy. Any leftover, changed PID, inactive mailbox unit or failed probe command prints its `FAIL` label and exits non-zero. The launcher preserves the probe exit code without converting a dirty-host result into `HostError`. For `list-unit-files` only, systemd exit 1 with empty stdout means no matches; other nonzero results remain failures. Retain external state and report failures; do not hand-clean the host.

`destroy` prints one terminal `deleted`, `failed` or `skipped` line per planned resource, including independent deletions when another resource fails. The receipt uses Alchemy's structured apply events, not parsed error text. A resource that never reaches a terminal delete event is reported as skipped.

Interrupted creates without recorded output read as absent when their saved props are incomplete. Alchemy recovers output through `read` before attempting delete; an absent result skips that provider callback. The deployment delete port also accepts partial olds without output as a no-op, without validating create-only URLs or inferring deletion authority from old props. Sibling file, directory, binary, unit, node, bucket and runtime-file deletes guard missing output. Recorded output still passes the existing custody checks. Offline rollback tests cover the full 24-row graph and the 22-row remainder after the independent retention service and timer have already been removed.

## Checks

Root `pnpm check` and `pnpm test` include this package. The normal suite makes no SSH calls. The gated live test requires `RAT_KING_LIVE_NODE` and reads its target only from the private inventory. Disable Alchemy telemetry for live tests with `ALCHEMY_TELEMETRY_DISABLED=1`.

The live test creates a random `rat-king-test-*.service`, checks its memory and CPU caps, lowers its memory cap, adopts it with the same PID, proves a noop plan, deletes it and probes for zero test units and files. It creates `rat-king.slice` only when its file is absent and removes that slice only when the test created it.

The Linux lifecycle and release archive reader adapt homeflare-kit at `cf20298`. Its MIT notice is in `LICENSE-homeflare-kit`.

## Consuming from another repository

The package is not published to a registry. A consumer pins it from a full rat-king commit sha:

```json
"@rat-king/alchemy-nest": "github:joelhooks/rat-king#<full sha>&path:/packages/alchemy-nest"
```

Never use a branch or tag. The sha is the pin, and the consumer's lockfile records it.

The package ships TypeScript source. Node does not strip types under `node_modules`; plain Node 24 fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Pinned consumers need a runner that transforms dependency TypeScript, such as jiti 2.7.0, or a bundler. Set `allowImportingTsExtensions` when typechecking.

| Entry point | Exports |
| --- | --- |
| `@rat-king/alchemy-nest` | `providers`, the four resources and their provider layers, `HostShell`, `HostError`, `RatsNest`, `Ssh`, `ReleaseSource`, `sourceLayer`, `ObjectStore`, `Celld` and the prop and attribute types |
| `@rat-king/alchemy-nest/RatsNest` | `RatsNest` (`Host`, `layer`), `Host`, `layer` and `InventoryError` |

The consumer's pins must match this package exactly: `alchemy` `2.0.0-beta.87` and `effect` `4.1.4`. Pin both in the consumer's own `package.json` with no range. A different alchemy or effect resolves a second copy, and the provider and service types stop lining up.

The package declares no `workspace:` or `catalog:` specifiers, so it resolves outside this workspace. Keep it that way.

Two consumer settings in `pnpm-workspace.yaml`:

- `allowBuilds` for `esbuild` and `workerd`. Without it, `pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS`.
- An override `"@effect/platform-node-shared": "4.1.4"` to keep it aligned with the exact `effect` and `@effect/platform-node` 4.1.4 pins.
