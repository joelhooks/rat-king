# Mailbox proof

Local proof only. No deployment authority, Cloudflare deployment or real recipient sends. The optional hosted Worker wakes an agent DO after mailbox admission.

`src/worker.ts` projects generated `@rat-king/lexicon` routes. Application Effect services own admission, idempotency, sequenced events, snapshots and leases. The SQL adapter groups authoritative changes in DO SQLite transactions. The XState v6 delivery machine keeps wake results out of delivery state.

One Mailbox DO is named by recipient DID. A separate AuthTokens DO owns service-wide JWT replay rejection across all mailboxes and methods. DID documents in Worker configuration contain only public P-256 JWKs and explicit authentication/keyAgreement membership. The proof admits configured did:web accounts; network resolution and key-history verification are later adapters.

Bindings and build metadata live in `src/bindings.ts`. Bundles require build-supplied version and commit; `/.well-known/rat-king/version` reports those literals. No runtime Git access. No tracked Wrangler configuration.

The lease authority's acquire/renew/release and injection-evidence methods are DO RPC only. Listing never mutates delivery. Ack requires current, unexpired lease ID/generation and a delivered message; repeated valid acks return their original receipt. TerminalDelivery records sender-authorized expiry or terminal failure without reviving terminal messages. The optional hosted-agent adapter supplies runtime injection. No expiry scheduler or owner notification transport is supplied: trusted adapters must call those private ports and consume receipt events. Transient wake failures must not call terminal failure.

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

The harness generates Wrangler config and an entry module in an OS temp directory, allocates a loopback port, starts its own celld process, waits for observed readiness and terminates that process on scope exit. `test/worker.ts` exposes private lease RPC for tests only. Production never imports it and has no public lease route.

The exported `outcomeProof(baseUrl, sample)` and generated-client HTTP adapter can be reused against a P6 target provisioned with matching ephemeral public DID documents. The version readback expectation is the explicit proof build. Cloudflare adapter qualification remains undone.

## Local runtime provenance

celld v0.6.1, arm64 macOS asset: `https://github.com/denoland/celld/releases/download/v0.6.1/celld-aarch64-apple-darwin.gz`

Release SHA-256 (compressed asset): `3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95`

The generated server's runtime `@atproto/lexicon` dependency bundled and initialized successfully on celld. ES256 service auth uses `crypto.subtle.importKey('jwk')` and `crypto.subtle.verify` with ECDSA P-256/SHA-256 inside celld. A bundle-graph test confirms the test Worker includes the envelope compatibility adapter; HPKE is no longer forbidden in Worker graphs.

The v0.6.1 isolate has two P-256 WebCrypto defects: raw public export returns 91-byte SPKI instead of 65-byte SEC1 (`crates/celld/js/crypto.js:339-344`), and raw ECDH public import is unsupported (`crypto.js:254-327`). The envelope package applies instance-local, guarded serialization/import adapters, including an on-curve check before JWK import. `/test/p256-raw` still reproduces the original 91-byte export. `/test/hpke/open` opens a Node-sealed envelope; `/test/hpke/seal` seals a reply that Node opens and verifies. One real-node test proves both directions. These routes exchange ephemeral proof keys over loopback only and never enter the production Worker. No suite, AAD, signing-byte, wire-version or pin changes. Crypto remains **unreviewed**; see the envelope README for repros, source locations and removal conditions.
