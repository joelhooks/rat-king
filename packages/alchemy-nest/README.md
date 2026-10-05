# Alchemy Nest

Alchemy v2 providers for Linux hosts over SSH. They run as a non-root user. `SystemdUnit` accepts user scope only; it never calls sudo or the system manager.

## Ports and layers

- `RatsNest.Host` loads the private inventory through `RatsNest.layer`. `node(alias)` returns `ssh`, `tailnetIPv4`, `home` and `dataRoot`. The inventory defaults to `~/.config/rats-nest/instance.json`; `RATS_NEST_INSTANCE` overrides it. Missing, malformed or non-600 inventory fails closed. Legacy inventory without `nodes` still loads, but cannot resolve a node.
- `HostShell` owns remote filesystem operations and command execution. `Ssh.layer(node)` uses the system SSH binary with batch mode, strict host-key checking, a connection timeout and an interruptible command timeout. Supply Node platform services to the layer.
- `ReleaseSource` owns downloads. `sourceLayer` needs an Effect HTTP client. Tests replace both ports with in-memory implementations.
- `providers()` registers all four resources. Individual provider layers are exported too. Each provider layer captures its host shell; use separate stack namespaces and state for separate hosts.

Keep host facts and Alchemy state outside this repository. Pass runtime inventory values to declarations. Do not put credentials in resource props: Alchemy persists props and outputs in state, including file content.

## Resources

| Resource | Inputs | Behavior |
| --- | --- | --- |
| `SystemdUnit` | `scope: "user"`, `home`, `name`, `sections`, optional `enabled`, `started`, `restartOn` | Writes under the supplied home's `.config/systemd/user/`. Renders ordered section/key/value pairs, including repeated directives. Supports `.service` and `.slice`. An Install section defaults enablement on; slices without one stay static. |
| `RemoteFile` | Absolute `path`, `content`, optional numeric `mode` | Atomic write and digest/mode readback. Mode-only updates use chmod. Mode `0o600` is supported. |
| `HostDirectory` | Absolute `path`, optional numeric `mode` | Creates one directory, not its parents. Deletes with rmdir and refuses a nonempty directory. |
| `ReleaseBinary` | Absolute `path`, GitHub release `url`, mandatory archive `sha256` and `size`, `asset`, optional numeric `mode` | Verifies the download before any installation. Raw assets use `{ format: "raw" }`. Gzip tar assets use `{ format: "tar.gz", member, memberSha256, root? }`. Verifies the exact member too. Default mode is `0o755`. |

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

Existing resources read as `Unowned`; adoption needs Alchemy's explicit adopt policy. Units and binaries must match the declared bytes before adoption. Unit identity changes use delete-first replacement, with the target checked before deleting the old unit. Other path changes replace the resource. Directory deletion never removes undeclared data.

## Checks

Root `pnpm check` and `pnpm test` include this package. The normal suite makes no SSH calls. The gated live test requires `RAT_KING_LIVE_NODE` and reads its target only from the private inventory. Disable Alchemy telemetry for live tests with `ALCHEMY_TELEMETRY_DISABLED=1`.

The live test creates a random `rat-king-test-*.service`, checks its memory and CPU caps, lowers its memory cap, adopts it with the same PID, proves a noop plan, deletes it and probes for zero test units and files. It creates `rat-king.slice` only when its file is absent and removes that slice only when the test created it.

The Linux lifecycle and release archive reader adapt homeflare-kit at `cf20298`. Its MIT notice is in `LICENSE-homeflare-kit`.
