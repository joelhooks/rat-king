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

### One real-loop proof

`apps/mailbox/test/agent-loop-celld.test.ts` skips unless the named binary and both readable gateway files exist. It bundles the composition Worker and the actual CLI, provisions temporary sender and agent identities under invented `.example.invalid` DIDs, and starts celld on loopback. It runs CLI send, waits for the reply, and runs CLI open as the sender. `RAT_KING_MAILBOX_CLIENT_LABEL` selects the local CLI alias; the public fixture defaults to `sender`. Assertions require verified=true, the agent sender, matching replyTo, non-empty answer and an acked original. It resends the exact original ciphertext with fresh service auth, waits for two completed drains, and requires one reply and one persisted submission after a one-second observation window. It redacts gateway URL, hostname and key in errors and trashes temporary secrets after stopping its processes.

```sh
RAT_KING_CELLD=/path/to/verified/celld \
RAT_KING_MODEL_GATEWAY_KEY_FILE=/path/to/private/key \
RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE=/path/to/private/endpoint \
pnpm exec vitest run --config apps/mailbox/vitest.config.ts apps/mailbox/test/agent-loop-celld.test.ts
```

Observed local result: the final real sol run, after merging the sidecar landing, passed in **9.65 seconds**. Two real sol turns ran in total: the initial proof and the owner-requested post-merge proof. No third attempt ran. The CLI alias in this pasted output is anonymized.

```text
S5 mailbox loop: mode=gpt-6-sol low; endpoint/key [REDACTED]
send --from [client]: {"receipt":{"message":{"messageId":"3mx4bqoug5ktr","senderDid":"did:web:sender.example.invalid"},"recipientDid":"did:web:agent.example.invalid","seq":1,"state":"accepted"}}
open --as [client]: {"body":"2 + 2 = 4.","replyTo":{"messageId":"3mx4bqoug5ktr","senderDid":"did:web:sender.example.invalid"},"senderDid":"did:web:agent.example.invalid","tid":"3mx4bqozq3222","verified":true}
original=acked; duplicate receipt=original; reply count=1; submission count=1; wake receipts=2 accepted; tools/extensions=0
```

The same proof can qualify local wiring without gateway calls using `RAT_KING_MAILBOX_FAUX_PROOF=1` and the named celld binary, with no gateway files. Faux passed locally. A small unit test checks same-origin dispatch, foreign-origin/port and userinfo refusals, and redirect suppression.

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
