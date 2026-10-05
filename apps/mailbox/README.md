# Mailbox proof

Proof only. No deployment authority, Cloudflare deployment, wake adapter or real recipient sends.

`src/worker.ts` projects generated `@rat-king/lexicon` routes. Application Effect services own admission, idempotency, sequenced events, snapshots and leases. The SQL adapter groups authoritative changes in DO SQLite transactions. The XState v6 delivery machine keeps wake results out of delivery state.

One Mailbox DO is named by recipient DID. A separate AuthTokens DO owns service-wide JWT replay rejection across all mailboxes and methods. DID documents in Worker configuration contain only public P-256 JWKs and explicit authentication/keyAgreement membership. The proof admits configured did:web accounts; network resolution and key-history verification are later adapters.

Bindings and build metadata live in `src/bindings.ts`. Bundles require build-supplied version and commit; `/.well-known/rat-king/version` reports those literals. No runtime Git access. No tracked Wrangler configuration.

The lease authority's acquire/renew/release and injection-evidence methods are DO RPC only. Listing never mutates delivery. Ack requires current, unexpired lease ID/generation and a delivered message; repeated valid acks return their original receipt. TerminalDelivery records sender-authorized expiry or terminal failure without reviving terminal messages. No runtime injection, expiry scheduler or owner notification transport is supplied by this proof: trusted adapters must call those private ports and consume receipt events. Transient wake failures must not call terminal failure.

Canonical envelope bytes identify a sender-DID/TID admission forever in this proof: records and terminal receipts are not pruned. There are therefore no retention gaps or CursorExpired cases yet. SenderReservation is a typed seam only. A recipient DO cannot reserve the same sender/TID across different recipients; the sender outbox/handoff belongs to later work.

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

The generated server's runtime `@atproto/lexicon` dependency bundled and initialized successfully on celld. ES256 service auth uses `crypto.subtle.importKey('jwk')` and `crypto.subtle.verify` with ECDSA P-256/SHA-256 inside celld. A bundle-graph test excludes client HPKE code from the production Worker.

The v0.6.1 isolate's P-256 raw-export defect blocks client HPKE in celld. The isolated test Worker reproduces it at `/test/p256-raw`: generate an extractable ECDH P-256 pair, then export the public key as `raw`. It returns 91-byte SPKI, not 65-byte SEC1. `crates/celld/js/crypto.js:339-344` returns stored bytes without P-256 conversion. Node-client RFC and envelope proofs remain valid; this is not Worker-HPKE qualification, and no crypto patch or suite change is applied. Crypto remains **unreviewed**; see the envelope package.
