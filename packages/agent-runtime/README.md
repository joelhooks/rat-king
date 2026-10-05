# Durable agent proof

A pi-durable Harness answers inside a celld v0.6.1 Durable Object using the object's own SQLite. Killing the isolate node during a committed tool run and restarting on the same data directory settles the original submission. This is test-only, not a deployed agent service.

## Port and adapter

`src/port.ts` owns Effect Schema contracts and the `AgentHarness` service: `submit({ requestId, content })` returns a branded submission ID, `wait(id)` returns `Done { id, answer }` or `Unanswered { id, reason }`, and `resume()` continues checkpointed work. Operations fail with `HarnessFailure`. The public port imports no pi-durable, chord or pi-ai types.

`piDurableLayer(storage, options, model)` implements that port. Its scoped Layer owns one Harness and closes it on scope exit. Provider setup stays in the adapter's caller. Without model bindings the test installs faux; with model bindings it installs model gateway. One Harness owns each storage.

`durableSqlite(host)` adapts synchronous DO SQL to pi-durable's asynchronous facade. A Promise tail orders all outside operations, transactions and close. Transaction callbacks receive a separate executor that expires when the callback settles. Other work cannot enter that transaction. The host transaction owns commit and rollback; close drains the queue without closing the DO's host-owned SQLite connection. Bigints must fit JavaScript's safe integer range; byte arrays become DO SQL blob bindings.

Sources: [pi-durable's facade contract](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/durable/src/storage/sqlite/database.ts), [celld v0.6.1 async transactions](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/js/harness.js#L1898-L2011), and the existing `apps/mailbox/src/worker.ts` SQL binding. celld's async transaction holds the input gate, wraps a SQLite savepoint and permits the callback's root SQL handle to use that transaction. The facade adds its own queue because the upstream contract also excludes concurrent work from the same event.

## Real-node proof

```sh
RAT_KING_CELLD=/path/to/verified/celld pnpm test
```

Without that variable, the real-node test skips. The separate SQLite facade test checks rollback, queue ordering, expired handles and close.

`test/worker.ts` exposes submit, wait-by-id and test-only evidence/release routes. Every DO request reuses or reopens its Harness and calls `resume()`. The proof first settles an ordinary faux answer. A second faux turn commits a tool-call response. The tool persists an entered marker and blocks. Its `replay: "safe"` policy permits re-execution after restart; the restart request sets a persistent release flag before resuming.

The test kills both the actual isolate node and its `celld dev` supervisor with SIGKILL. Killing just the supervisor would leave the node alive on macOS and would not prove recovery. It restarts on the same directory, releases the tool and waits for the original ID. Stored entries contain exactly one unchanged tool-call response, one tool result and one final answer. The request ID and submission ID remain unchanged. Faux call counts are two before the crash (ordinary answer and tool call), then one after restart (final answer). The pre-crash model turn is not regenerated. Safe tool execution is replayed; arbitrary side effects are not exactly-once.

The test bundles with esbuild for a browser isolate. Imports use pi-ai's models/faux subpaths and pi-durable's portable SQLite subpath. The bundle's contributing modules exclude the root pi-ai entry and unrelated AWS/Google SDKs. The real-model adapter includes the OpenAI and Anthropic SDKs. No Node shim, upstream patch or fork is needed. The proof listens only on loopback and stops its owned processes.

## Model access

`src/model-access.ts` provides `ModelAccess` through an Effect Layer. `Config` reads `MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_CREDENTIAL` as `Redacted`, and `MODEL_GATEWAY_MODEL` (default `gpt-6-sol`). The exact allowlist is `gpt-6-sol`, `gpt-6-luna`, and `claude-opus-5-5`. A different ID fails with `ModelRefused` before provider construction or any fetch. The refusal unit test checks both `claude-sonnet-5` and `claude-fable-5-1`.

The adapter connects to an OpenAI- and Anthropic-compatible model gateway. The provider exposes only the validated selection, with static Bearer auth and no environment lookup, discovery, aliases or model fallback. Use the proxy's IDs verbatim: `gpt-6-sol`, not Pi's native-provider name `gpt-6.1-sol`. Sol/Luna use pi-ai's OpenAI completions API. Opus uses its native Anthropic messages API; that SDK appends `/v1/messages`, so the adapter removes the OpenAI base URL's final `/v1`. Imports use the models and lazy API subpaths only. The 32,768-token context and 1,024-token output ceilings are local POC limits, not measured provider limits. Cost rates are unknown and represented as zero; recorded token usage is not a billing receipt.

Sol and Luna receive the model-gateway base URL as a plain binding and the key as a secret binding. Opus now uses `CLAUDE_SIDECAR_BASE_URL` (explicit loopback HTTP port and `/v1` path) and `CLAUDE_SIDECAR_CREDENTIAL`; missing sidecar config fails closed. The default remains `gpt-6-sol`. See [the sidecar proof](../../apps/claude-sidecar/README.md). Invented example values only:

```json
{
  "MODEL_GATEWAY_BASE_URL": "https://models.example.invalid/v1",
  "MODEL_GATEWAY_CREDENTIAL": "example-key",
  "MODEL_GATEWAY_MODEL": "gpt-6-sol"
}
```

The S4 test-only Worker selects a separate named agent per `?model=` value; the Layer validates it. Its direct-gateway Opus probe below is historical; the current Opus proof lives in `apps/claude-sidecar/test/real.test.ts`. Missing model bindings retain the S3 faux fixture. There is no deployed service or deployment authority in this proof.

```sh
RAT_KING_CELLD=/path/to/verified/celld \
RAT_KING_MODEL_GATEWAY_KEY_FILE=/path/to/private/key \
RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE=/path/to/private/endpoint \
pnpm exec vitest run --config packages/agent-runtime/vitest.config.ts packages/agent-runtime/test/model-access-celld.test.ts
```

Without a named binary and both readable private files, the sol proof skips. It generates config and `.dev.vars` (the local secret binding) in an OS temp directory, both mode 600. It starts celld on loopback, submits one question with low thinking and no retries, and asserts `Done`, non-empty assistant text, and a persisted `pi.usage` entry. Scoped cleanup stops its processes and trashes the directory. Error output redacts the endpoint, its hostname and the key.

Observed sol result: **316 input + 12 output = 328 tokens**, settled `Done`. The initial run reached `Done` but its evidence assertion failed because pi-durable stores indexed document kinds as JSON strings. The corrected query reads `record.kind`; a second sol turn passed. No successful sol proof was repeated after that.

Opus is opt-in through `RAT_KING_MODEL_GATEWAY_OPUS_PROOF=1`. Its separate test makes one native messages request with thinking off, no tools, no beta headers, no identity cloaking and no retries. It records the observed outcome, not a success assertion. Unexpected success prints a stop marker requiring an owner decision about paid extra usage. Run only that case with `-t 'celld Opus'` when separately authorized.

**Opus not proven.** The first request returned `404 status code (no body)` because the SDK received an OpenAI `/v1` base and requested `/v1/v1/messages`. After fixing the route and obtaining approval for one corrected attempt, the gateway returned HTTP 400 at **2026-10-05T05:27:49Z**:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "\"thinking.type.disabled\" is not supported for this model. Use \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."
  }
}
```

No further calls were made. This is not evidence of the anticipated extra-usage refusal or of successful Opus generation. A future adaptive-thinking probe needs separate approval. Luna, model-key revocation, rate limits, provider failure recovery, real-model crash recovery and paid usage remain untested.

The current minified browser Worker bundle is **1,221,199 bytes**: **+221,713 bytes** over the sol-only adapter (999,486 bytes), and **+569,220 bytes** over the S3 faux-only bundle. The shared fixture includes both provider SDKs; no additional dependency or lockfile change was needed.

## S3 memory baseline

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

Not tested: Cloudflare, deployment, multiple production DOs, sustained load, cancellation, unsafe tools, schema upgrades, all SQLite conformance cases, rollback failure, or crash at every instruction boundary. A crash during an uncommitted faux stream may reissue the model request; faux deferred handles are process-local. This proof covers recovery after a committed tool-call response, not durable provider-side streaming or exactly-once external model requests.
