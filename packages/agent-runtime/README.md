# Durable agent proof

A pi-durable Harness answers inside a celld v0.6.1 Durable Object using the object's own SQLite. Killing the isolate node during a committed tool run and restarting on the same data directory settles the original submission. The local crash-recovery proof was retired; this is not a deployed agent service.

## Port and adapter

`src/port.ts` owns Effect Schema contracts and the `AgentHarness` service: `submit({ requestId, content })` returns a branded submission ID, `wait(id)` returns `Done { id, answer }` or `Unanswered { id, reason }`, and `resume()` continues checkpointed work. Operations fail with `HarnessFailure`. The public port imports no pi-durable, chord or pi-ai types.

`piDurableLayer(storage, options, model)` implements that port. Its scoped Layer owns one Harness and closes it on scope exit. Provider setup stays in the adapter's caller. Without model bindings the test installs faux; with model bindings it installs model gateway. One Harness owns each storage.

`durableSqlite(host)` adapts synchronous DO SQL to pi-durable's asynchronous facade. A Promise tail orders all outside operations, transactions and close. Transaction callbacks receive a separate executor that expires when the callback settles. Other work cannot enter that transaction. The host transaction owns commit and rollback; close drains the queue without closing the DO's host-owned SQLite connection. Bigints must fit JavaScript's safe integer range; byte arrays become DO SQL blob bindings.

Sources: [pi-durable's facade contract](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/durable/src/storage/sqlite/database.ts), [celld v0.6.1 async transactions](https://github.com/denoland/celld/blob/v0.6.1/crates/celld/js/harness.js#L1898-L2011), and the existing `apps/mailbox/src/worker.ts` SQL binding. celld's async transaction holds the input gate, wraps a SQLite savepoint and permits the callback's root SQL handle to use that transaction. The facade adds its own queue because the upstream contract also excludes concurrent work from the same event.

## Checks

`pnpm test` runs the retained local suites. The SQLite facade tests check rollback, queue ordering, expired handles and close.

The celld crash-recovery suite and its test Worker were retired. No current runner reproduces that proof.

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

### Historical model qualification

The celld model-access suite was retired. Results below record past local runs, not current qualification. The sidecar's earlier local proof is recorded in its [README](../../apps/claude-sidecar/README.md#local-proof-receipt).

Observed sol result: **316 input + 12 output = 328 tokens**, settled `Done`. The initial run reached `Done` but its evidence assertion failed because pi-durable stores indexed document kinds as JSON strings. The corrected query reads `record.kind`; a second sol turn passed. No successful sol proof was repeated after that.

The retired Opus probe made one native messages request with thinking off, no tools, no beta headers, no identity cloaking and no retries. It recorded the observed outcome, not a success assertion.

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

The historical minified browser Worker bundle was **1,221,199 bytes**: **+221,713 bytes** over the sol-only adapter (999,486 bytes), and **+569,220 bytes** over the S3 faux-only bundle. The shared fixture includes both provider SDKs; no additional dependency or lockfile change was needed.

## Hosted mailbox loop

`src/mailbox-loop.ts` owns AgentMailbox, AgentJournal and AgentKeys contracts and the Effect drain. `src/hosted.ts` adapts one hosted agent DID to one DO and one pi-durable Harness. The mailbox composition Worker supplies local authenticated XRPC and static DID resolution. No provider implementation enters the loop contract.

The XState lifecycle checkpoints pending → submitted → answered → sealed → replied → acked. An unanswered submission checkpoints unanswered → failed and records a terminal mailbox receipt with the public-safe detail `Agent harness settled unanswered`; its exact reason stays in the private agent journal. Each submission uses `requestId = senderDid/messageId`. The journal stores the submission ID and the exact sealed reply before sending. A retry reuses that ciphertext and sender/TID, rather than resealing a conflicting admission. Journal operations use the same queued SQLite facade as the Harness. A DO-owned Promise tail serializes whole drains. Completed drains and safe operation-only failures remain available through private evidence RPC.

The registry is empty: **no tools, no CodingTools, no tool-bearing extensions, no shell, filesystem or network tools**. Model input is text; settlement returns text. The agent adds no listener. In gateway mode its only outbound transport is the model gateway's configured origin. `src/model-egress.ts` passes an origin-checked fetch into both provider stream methods, rejects other origins with EgressRefused, and disables automatic redirects. The guarded provider exposes static chat models only, without discovery, refresh, deferred, image or classification network paths. Replies stay within the Worker through Mailbox stubs.

Worker configuration selects the same code path:

- `AGENT_MODEL=gateway`: requires `MODEL_GATEWAY_BASE_URL` and the secret `MODEL_GATEWAY_CREDENTIAL`; `MODEL_GATEWAY_MODEL` defaults to `gpt-6-sol`. The existing exact allowlist still applies. The proof uses low thinking, no retry and a 45-second model stream timeout.
- `AGENT_MODEL=faux`: installs pi-ai's faux provider with the scripted one-line answer `Faux agent answer.` on every turn. Both gateway URL and credential bindings must be absent, not empty. No proxy origin or network-capable provider is installed. This is the mode available to a later faux deployment; it does not authorize one.
- `HOSTED_AGENTS`: JSON array of agent DIDs only. No host inventory or addresses.
- `AGENT_IDENTITIES_CREDENTIAL`: secret JSON array of `{ did, signing, agreement }` with private P-256 JWKs. It never enters tracked config or Alchemy state. The local proof generates it in a mode-600 OS-temp `.dev.vars`. celld v0.6.1 strips outer quotes but does not JSON-unescape them, so this binding contains raw one-line JSON, not a double-encoded JSON string.

The hosted adapter wraps ModelAccess without changing `src/model-access.ts`. The workspace lockfile adds only the mailbox → runtime and runtime → envelope/lexicon/XState links; no external dependency version changed.

### Historical real-loop proof

The celld mailbox-loop suite was retired. The receipt below records an earlier local run, not a current qualification command.

Observed local result: the final real sol run, after merging the sidecar landing, passed in **9.65 seconds**. Two real sol turns ran in total: the initial proof and the owner-requested post-merge proof. No third attempt ran. The CLI alias in this pasted output is anonymized.

```text
S5 mailbox loop: mode=gpt-6-sol low; endpoint/key [REDACTED]
send --from [client]: {"receipt":{"message":{"messageId":"3mx4bqoug5ktr","senderDid":"did:web:sender.example.invalid"},"recipientDid":"did:web:agent.example.invalid","seq":1,"state":"accepted"}}
open --as [client]: {"body":"2 + 2 = 4.","replyTo":{"messageId":"3mx4bqoug5ktr","senderDid":"did:web:sender.example.invalid"},"senderDid":"did:web:agent.example.invalid","tid":"3mx4bqozq3222","verified":true}
original=acked; duplicate receipt=original; reply count=1; submission count=1; wake receipts=2 accepted; tools/extensions=0
```

The retired faux variant also passed locally without gateway calls. Retained local tests check same-origin dispatch, foreign-origin/port and userinfo refusals, and redirect suppression.

Not tested for this loop: deployment or Cloudflare; multiple hosted agents or questions; the door-3 secret-file shortcut as a production key-delivery mechanism; real-key custody, rotation or DID resolution; crash at reply/ack boundaries; failed/unanswered receipt behavior end to end; gateway failures, revocation or rate limits; lease contention or takeover; pagination under concurrent admissions; expiry, pruning, sustained load, alarms or missed-wake recovery. Wakes are best-effort, not a durable scheduler. Failed drains do not automatically retry or claim success. Crypto remains unreviewed. No deployment, release or publication capability changed.

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
