# Alchemy Nest

Alchemy v2 providers for Linux hosts over SSH. They run as a non-root user. `SystemdUnit` accepts user scope only; it never calls sudo or the system manager.

## Ports and layers

- `RatsNest.Host` loads the private inventory through `RatsNest.layer`. `node(alias)` returns `ssh`, `tailnetIPv4`, `home` and `dataRoot`. The inventory defaults to `~/.config/rats-nest/instance.json`; `RATS_NEST_INSTANCE` overrides it. Missing, malformed or non-600 inventory fails closed. Legacy inventory without `nodes` still loads, but cannot resolve a node.
- `HostShell` owns remote filesystem operations and command execution. `Ssh.layer(node)` uses the system SSH binary with batch mode, strict host-key checking, a connection timeout and an interruptible command timeout. Supply Node platform services to the layer.
- `ReleaseSource` owns downloads. `sourceLayer` needs an Effect HTTP client. Tests replace both ports with in-memory implementations.
- `providers()` registers all four resources. Individual provider layers are exported too. Each provider layer captures its host shell; use separate stack namespaces and state for separate hosts.

Keep host facts and Alchemy state outside this repository. Pass runtime inventory values to declarations. Never put plaintext credentials in resource props. Secret file content uses Effect `Redacted`; Alchemy persists the secret in external state. Keep that state in an owner-only directory.

## Resources

| Resource | Inputs | Behavior |
| --- | --- | --- |
| `SystemdUnit` | `scope: "user"`, `home`, `name`, `sections`, optional `enabled`, `started`, `restartOn` | Writes under the supplied home's `.config/systemd/user/`. Renders ordered section/key/value pairs, including repeated directives. Supports `.service` and `.slice`. An Install section defaults enablement on; slices without one stay static. |
| `RemoteFile` | Absolute `path`, `content`, optional numeric `mode` | Atomic write and digest/mode readback. Mode-only updates use chmod. Redacted content requires mode `0o600`. |
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

`ObjectStore.Bucket(id, { host, name, slice, purgeOnDelete? })` composes the pinned SeaweedFS 4.48 binary, generated Alchemy `Random` secrets, a mode-600 identity file, owned directories and a user service. Its final `ObjectStore.Bucket` resource creates a non-versioned bucket through signed S3 requests. Outputs include `endpoint`, `bucketName`, `region`, `accessKey` and `secretKey`; credentials remain redacted outputs.

Declare `ObjectStore.Slice(host.home)` once per stack. Pass its `sha256` output to each bucket's `slice` input. The user slice caps aggregate memory, swap, CPU and tasks. SeaweedFS binds its eight fixed listeners to loopback, disables master telemetry, clears the Sentry DSN and disables the OTEL SDK. It explicitly sets `-s3.port.iceberg=0` and `-s3.port.lance=0`: pinned 4.48 `weed/command/server.go:170–171` documents zero as disabled; `weed/command/s3.go:401–408` guards both startup paths.

`Celld.Node(id, { host, bucket, purgeOnDelete? })` composes celld v0.6.1, a mode-600 environment file and a `Celld.Node` user-unit resource. Register `ObjectStore.providers()` and `Celld.providers()`. Outputs are `publicUrl`, `internalUrl`, `version` and the unit attributes. The public listener uses the inventory's address; the internal listener stays on loopback. Credentials never enter unit text. Telemetry is disabled.

The node uses systemd's default `Type=simple`: an active unit is not a health proof. celld v0.6.1 binds listeners before waiting for a deployment pointer, so open sockets are not an application health proof. The live node lifecycle checks pointer existence and seeds the approved fixed-body bootstrap only if it is absent, then starts the node. The bootstrap probe publishes the fixed-body module fixture with a generated temporary `no_bundle` configuration; it leaves the deployment pointer for the next application to replace.

Opt-in purge drains paginated bucket objects before DeleteBucket. Alchemy dependencies then stop the store and remove its dedicated data directory. The node stops before its work directory is purged. The proof stack opts in; normal resource declarations do not. Never run destroy without separate authorization.

The live provider layer installs `UnitStartup` checks in both SystemdUnit and Celld.Node create/update reconciliation. Only missing allowed sockets may wait for up to ten seconds; any extra port, wrong process or wrong bind stops both units immediately and fails the reconcile. Store startup requires its exact eight ports; node startup requires the final ten. No diagnose runs before that gate. Probe diagnostics retain at most 16 KiB of stderr, redact generated credentials and host facts, and drain the stream.

## Live probes

The `live` package script requires `RAT_KING_LIVE_NODE` and an external `RAT_KING_STATE_DIR`. It validates the private inventory and disables Alchemy telemetry. Commands are `preflight`, `plan`, `deploy`, `bootstrap`, `bootstrap-check`, `diagnose`, `race`, `store-listeners`, `listeners`, `status`, `uid-probe` and `health`. The store-only listener check covers the interval while the node waits for its first deployment. `deploy` also requires `RAT_KING_START_APPROVED=true`; `race` requires `RAT_KING_RACE_APPROVED=true`. Those switches record an already-granted owner approval, not permission to start a shared-host workload.

The diagnose and race probes run in transient user scopes inside the same slice with a 64 MiB memory cap, no swap, 10% CPU, 64 tasks and nice level 10 through a nice wrapper, not an invalid scope property. The race issues exactly 50 simultaneous conditional creates for a fresh key, requires one HTTP 200 and 49 HTTP 412s, and deletes the key even on failure. A failed conformance probe stops the proof; it does not select another store.

Run `pnpm --filter @rat-king/alchemy-nest live <command>` with those environment variables set. The normal test command never invokes these probes. Preserve the external state directory for the next packet.

## Checks

Root `pnpm check` and `pnpm test` include this package. The normal suite makes no SSH calls. The gated live test requires `RAT_KING_LIVE_NODE` and reads its target only from the private inventory. Disable Alchemy telemetry for live tests with `ALCHEMY_TELEMETRY_DISABLED=1`.

The live test creates a random `rat-king-test-*.service`, checks its memory and CPU caps, lowers its memory cap, adopts it with the same PID, proves a noop plan, deletes it and probes for zero test units and files. It creates `rat-king.slice` only when its file is absent and removes that slice only when the test created it.

The Linux lifecycle and release archive reader adapt homeflare-kit at `cf20298`. Its MIT notice is in `LICENSE-homeflare-kit`.
