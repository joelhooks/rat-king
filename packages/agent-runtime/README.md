# Durable agent proof

A pi-durable Harness answers inside a celld v0.6.1 Durable Object using the object's own SQLite. Killing the isolate node during a committed tool run and restarting on the same data directory settles the original submission. This is test-only, not a deployed agent service.

## Port and adapter

`src/port.ts` owns Effect Schema contracts and the `AgentHarness` service: `submit({ requestId, content })` returns a branded submission ID, `wait(id)` returns `Done { id, answer }` or `Unanswered { id, reason }`, and `resume()` continues checkpointed work. Operations fail with `HarnessFailure`. The public port imports no pi-durable, chord or pi-ai types.

`piDurableLayer(storage, options, model)` implements that port. Its scoped Layer owns one Harness and closes it on scope exit. Provider setup stays in the adapter's caller; the test installs faux only. One Harness owns each storage.

`durableSqlite(host)` adapts synchronous DO SQL to pi-durable's asynchronous facade. A Promise tail orders all outside operations, transactions and close. Transaction callbacks receive a separate executor that expires when the callback settles. Other work cannot enter that transaction. The host transaction owns commit and rollback; close drains the queue without closing the DO's host-owned SQLite connection. Bigints must fit JavaScript's safe integer range; byte arrays become DO SQL blob bindings.

Sources: [pi-durable's facade contract](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/durable/src/storage/sqlite/database.ts), [celld v0.6.1 async transactions](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/js/harness.js#L1898-L2011), and the existing `apps/mailbox/src/worker.ts` SQL binding. celld's async transaction holds the input gate, wraps a SQLite savepoint and permits the callback's root SQL handle to use that transaction. The facade adds its own queue because the upstream contract also excludes concurrent work from the same event.

## Real-node proof

```sh
RAT_KING_CELLD=/path/to/verified/celld pnpm test
```

Without that variable, the real-node test skips. The separate SQLite facade test checks rollback, queue ordering, expired handles and close.

`test/worker.ts` exposes submit, wait-by-id and test-only evidence/release routes. Every DO request reuses or reopens its Harness and calls `resume()`. The proof first settles an ordinary faux answer. A second faux turn commits a tool-call response. The tool persists an entered marker and blocks. Its `replay: "safe"` policy permits re-execution after restart; the restart request sets a persistent release flag before resuming.

The test kills both the actual isolate node and its `celld dev` supervisor with SIGKILL. Killing just the supervisor would leave the node alive on macOS and would not prove recovery. It restarts on the same directory, releases the tool and waits for the original ID. Stored entries contain exactly one unchanged tool-call response, one tool result and one final answer. The request ID and submission ID remain unchanged. Faux call counts are two before the crash (ordinary answer and tool call), then one after restart (final answer). The pre-crash model turn is not regenerated. Safe tool execution is replayed; arbitrary side effects are not exactly-once.

The test bundles with esbuild for a browser isolate. Imports use pi-ai's models/faux subpaths and pi-durable's portable SQLite subpath. The bundle's contributing modules exclude the root pi-ai entry and vendor SDKs. No Node shim, upstream patch or fork is needed. The proof listens only on loopback and stops its owned processes.

## Memory

Measured with celld v0.6.1 on arm64 macOS, using `ps -o rss` against the actual isolate-node PID, not the dev supervisor. A live-clock sampler probes every 25 ms during both runs; short spikes can fall between samples. Values are whole-process RSS, not an isolated V8 heap measurement.

| Measurement                            | KiB RSS |
| -------------------------------------- | ------: |
| Idle node, before loading the agent DO |  60,048 |
| After loading the agent DO             |  72,288 |
| Sampled peak across both runs          |  81,248 |
| Restarted node, after settlement       |  77,552 |

Minified test Worker bundle: **651,979 bytes**. Loading the DO added 12,240 KiB in this run. Temp artifacts include `before.json`, `after.json` and `measurement.json`.

## Upstream and limits

Experimental upstream API, pinned exactly: `@earendil-works/pi-durable`, `@earendil-works/chord` and `@earendil-works/pi-ai` are all **1.0.2**. Each installed package manifest declares **MIT**. Installation needed no release-age exclusions. The stale 0.86.1 exclusions remain untouched.

Not tested: real models or CLIProxyAPI, Cloudflare, deployment, multiple DOs, sustained load, cancellation, unsafe tools, schema upgrades, all SQLite conformance cases, rollback failure, or crash at every instruction boundary. A crash during an uncommitted faux stream may reissue the model request; faux deferred handles are process-local. This proof covers recovery after a committed tool-call response, not durable provider-side streaming or exactly-once external model requests.
