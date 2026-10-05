# Mailbox proof

Local proof only. No deployment authority, Cloudflare deployment or real recipient sends. The optional hosted Worker wakes an agent DO after mailbox admission.

`src/worker.ts` projects generated `@rat-king/lexicon` routes. Application Effect services own admission, idempotency, sequenced events, snapshots and leases. The SQL adapter groups authoritative changes in DO SQLite transactions. The XState v6 delivery machine keeps wake results out of delivery state.

One Mailbox DO is named by recipient DID. A separate AuthTokens DO owns service-wide JWT replay rejection across all mailboxes and methods. DID documents in Worker configuration contain only public P-256 JWKs and explicit authentication/keyAgreement membership. The proof admits configured did:web accounts; network resolution and key-history verification are later adapters.

Bindings and build metadata live in `src/bindings.ts`. Bundles require build-supplied version and commit; `/.well-known/rat-king/version` reports those literals. No runtime Git access. No tracked Wrangler configuration.

The lease authority's acquire/renew/release and injection-evidence methods are DO RPC. The authenticated proof-only `POST /rat-king/v0/lease` seam acquires or renews the issuer's own lease and optionally records delivery for a message reference. Listing never mutates delivery. Ack requires current, unexpired lease ID/generation and a delivered message; repeated valid acks return their original receipt. TerminalDelivery records sender-authorized expiry or terminal failure without reviving terminal messages. The optional hosted-agent adapter supplies runtime injection. No expiry scheduler or owner notification transport is supplied: trusted adapters must call those private ports and consume receipt events. Transient wake failures must not call terminal failure.

Canonical envelope bytes identify a sender-DID/TID admission forever in this proof: records and terminal receipts are not pruned. There are therefore no retention gaps or CursorExpired cases yet. SenderReservation is a typed seam only. A recipient DO cannot reserve the same sender/TID across different recipients; the sender outbox/handoff belongs to later work.

## Hosted mailbox loop

Use `src/hosted-worker.ts` to compose Mailbox, AuthTokens and Agent in one Worker. Bind `AGENT` to its Agent class, add Agent to the SQLite migration, and set `HOSTED_AGENTS` to a JSON array of hosted DIDs. The mailbox-only entry remains available without agent bindings. The mailbox app imports the agent-runtime port and composition adapter, never pi-durable.

After a successful authenticated send, the Worker best-effort calls the hosted recipient's private `wake()` RPC. Separate `wake_attempts` rows record accepted or unavailable; they never change delivery state. An accepted wake means the agent accepted work, not that it answered. Replaying an admitted envelope can wake the agent again, but returns its original admission receipt.

The agent acquires a mailbox lease, reads every page of one list snapshot, folds receipt events, and processes only accepted, queued or delivered messages. It renews before injection and acknowledgment. Listing itself still does not deliver anything. The agent opens and verifies envelopes inside the isolate, submits through AgentHarness, delivers its signed reply through the same XRPC authentication and routing handler as the CLI, then acknowledges the original. The reply's encrypted signed payload contains `replyTo`. Reply delivery uses same-Worker DO stubs, never an outbound HTTP call.

See [agent-runtime](../../packages/agent-runtime/README.md#hosted-mailbox-loop) for configuration, checkpoints, model egress restrictions and limits. Production has no evidence route; `test/agent-worker.ts` exposes loop evidence only for the owned loopback proof.

## Checks

`pnpm check` includes both new workspace typechecks and the unchanged strict stack gates. `pnpm test` includes unit suites and skips the real-node suite unless `RAT_KING_CELLD` names a binary.

```sh
RAT_KING_CELLD=/path/to/verified/celld pnpm test
```

The harness generates Wrangler config and an entry module in an OS temp directory, allocates a loopback port, starts its own celld process, waits for observed readiness and terminates that process on scope exit. `test/worker.ts` exposes private lease RPC for tests only. Production never imports it. Its separate `/rat-king/v0/lease` seam requires service authentication.

`outcomeProof(baseUrl, sample)` stays celld-dev-only: it uses `/test/lease` for private injection coverage. The shared production suite is `test/target.suite.test.ts`. Cloudflare adapter qualification remains undone.

## Shared target suite

The same file runs against any provisioned mailbox Worker. It uses production routes only. Its fast-check model tracks sent, delivered, acked and opened messages. A required command sequence covers every proof operation; a generated tail explores legal repeats and interleavings, checking the recipient's event log after each command. Each property run varies the plaintext and proves envelope encode/decode/open round trips. Fresh TIDs prevent collisions between runs on a long-lived target.

Generate fresh sender and recipient identities outside the repository. Parent directories must already exist; the helper refuses repository paths, symlinked parents that resolve into the repository, existing output files and identical output paths. It writes private identities with mode 600 and prints no keys:

```sh
node apps/mailbox/test/suite-identities.ts /tmp/suite-identities.json /tmp/suite-documents.json
```

Use new output filenames for each deployment/run. The public documents contain invented, unique `.example.invalid` DIDs and no private JWK fields. Deploy the public JSON array as `DID_DOCUMENTS`, then supply these inputs:

```sh
RAT_KING_SUITE_BASE_URL=https://mailbox.example.invalid \
RAT_KING_SUITE_SERVICE_DID=did:web:service.example.invalid \
RAT_KING_SUITE_IDENTITIES_FILE=/tmp/suite-identities.json \
RAT_KING_SUITE_VERSION=expected-build-version \
RAT_KING_SUITE_COMMIT=expected-build-commit \
pnpm exec vitest run --config apps/mailbox/vitest.config.ts apps/mailbox/test/target.suite.test.ts
```

`RAT_KING_SUITE_NUM_RUNS` defaults to 2 and accepts 1–20. Each run generates at most 12 random commands after the required sequence. Individual mailbox snapshots stop at 1000 events. The configured-target test has a 90-second deadline; the local harness has 120 seconds. Agent reply polling stops after 45 seconds, and original-ack polling after 10 seconds. Large run counts can hit the overall deadline. Missing required target inputs skip the configured-target test. Invalid supplied identities or run counts fail.

The private file shape is `{ sender, recipient, documents, agent? }`. Each identity uses the existing CLI shape `{ did, signing, agreement }`, with private P-256 JWKs. `documents` is the deployed public array, including the agent's public document when testing an agent. The file must be a regular, non-symlink mode-600 file.

To enable the agent command, set `RAT_KING_SUITE_AGENT_DID` and add its matching private identity as `agent`. Reuse the stack's provisioned identity; do not regenerate a different agent. Given the Worker secret's JSON array in a private file, this one-line conversion adds that existing identity without printing it:

```sh
node --input-type=module -e 'import fs from "node:fs"; const [suite, secret, did] = process.argv.slice(1); const value = JSON.parse(fs.readFileSync(suite)); value.agent = JSON.parse(fs.readFileSync(secret)).find(identity => identity.did === did); if (!value.agent) throw Error("Missing agent"); fs.writeFileSync(suite, JSON.stringify(value)); fs.chmodSync(suite, 0o600);' /tmp/suite-identities.json /tmp/agent-identities.json did:web:agent.example.invalid
```

Include the corresponding agent public document in `documents` and deployed `DID_DOCUMENTS`. The agent identity is required to authenticate the original-message ack readback. A configured agent DID with missing or mismatched identity fails before target requests. Without the DID, the agent command skips. Configure the hosted target in faux mode; the suite never reads gateway credentials or calls a model gateway.

For loopback proof, no target inputs are needed:

```sh
RAT_KING_CELLD=/path/to/verified/celld pnpm exec vitest run --config apps/mailbox/vitest.config.ts apps/mailbox/test/target.suite.test.ts
```

The local harness bundles production `src/hosted-worker.ts`, generates all three identities and public documents in OS temp, binds the agent identity through a mode-600 `.dev.vars`, sets faux mode and runs the same `targetProof`. It reuses the owned celld launcher, terminates its process and moves its temp directory to Trash on exit. It never imports a test Worker or calls `/test/*`. Nest stage, Cloudflare preview and real-model behavior are not tested by this local proof.

## Local runtime provenance

celld v0.6.1, arm64 macOS asset: `https://github.com/denoland/celld/releases/download/v0.6.1/celld-aarch64-apple-darwin.gz`

Release SHA-256 (compressed asset): `3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95`

The generated server's runtime `@atproto/lexicon` dependency bundled and initialized successfully on celld. ES256 service auth uses `crypto.subtle.importKey('jwk')` and `crypto.subtle.verify` with ECDSA P-256/SHA-256 inside celld. A bundle-graph test confirms the test Worker includes the envelope compatibility adapter; HPKE is no longer forbidden in Worker graphs.

The v0.6.1 isolate has two P-256 WebCrypto defects: raw public export returns 91-byte SPKI instead of 65-byte SEC1 (`crates/celld/js/crypto.js:339-344`), and raw ECDH public import is unsupported (`crypto.js:254-327`). The envelope package applies instance-local, guarded serialization/import adapters, including an on-curve check before JWK import. `/test/p256-raw` still reproduces the original 91-byte export. `/test/hpke/open` opens a Node-sealed envelope; `/test/hpke/seal` seals a reply that Node opens and verifies. One real-node test proves both directions. These routes exchange ephemeral proof keys over loopback only and never enter the production Worker. No suite, AAD, signing-byte, wire-version or pin changes. Crypto remains **unreviewed**; see the envelope README for repros, source locations and removal conditions.
