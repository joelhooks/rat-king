# Mailbox pilot

Local proof only. No deployment authority, Cloudflare deployment or real recipient sends. The optional hosted Worker wakes an agent DO after mailbox admission.

`src/worker.ts` projects generated `@rat-king/lexicon` routes. Application Effect services own admission, idempotency, sequenced events, snapshots and leases. The SQL adapter groups authoritative changes in DO SQLite transactions. The XState v6 delivery machine keeps wake results out of delivery state.

One Mailbox DO is named by recipient DID. A separate AuthTokens DO owns service-wide JWT replay rejection across all mailboxes and methods. DID documents in Worker configuration contain only public P-256 JWKs and explicit authentication/keyAgreement membership. The pilot admits configured or operator-registered did:web accounts. Static documents win over registration. Unknown-DID lookups touch the Mailbox DO for that name; that is acceptable for the pilot. Network resolution and key-history verification remain later adapters.

Bindings and build metadata live in `src/bindings.ts`. Bundles require build-supplied version and commit; `/.well-known/rat-king/version` reports those literals. No runtime Git access. No tracked Wrangler configuration.

The generated runtime XRPC methods acquire, renew, release and resolve the exclusive lease in each DID's Mailbox DO. Acquire never steals, even from the same issuer. The server mints a TID lease ID, increments the persistent generation and clamps expiry to five minutes. Renew and release require the current unexpired fence. Only the DID itself may change its lease. Resolve allows the DID or an issuer in `LEASE_RESOLVERS`, an optional JSON array that defaults to `[]`. Legacy lease rows still decode, and expiry or release never resets generation.

A sender with a live lease must supply its exact `leaseId` and `generation` to `mailbox.send`. The check reads the sender's own Mailbox DO. An unfenced send is allowed only without a live lease; any supplied stale or partial fence is refused. `mailbox.deliver` requires the recipient's fence and records runtime injection. Repeating delivery returns the original delivery receipt without appending another event. Listing never mutates delivery. Ack requires current, unexpired lease ID/generation and a delivered message; repeated valid acks return their original receipt. TerminalDelivery records sender-authorized expiry or terminal failure without reviving terminal messages. The optional hosted-agent adapter supplies runtime injection. No message-expiry scheduler is supplied: trusted adapters must call those private ports and consume receipt events. Transient wake failures must not call terminal failure.

Canonical envelope bytes identify a sender-DID/TID admission forever in this proof: records and terminal receipts are not pruned. There are therefore no retention gaps or CursorExpired cases yet. SenderReservation is a typed seam only. A recipient DO cannot reserve the same sender/TID across different recipients; the sender outbox/handoff belongs to later work.

## Push socket

Upgrade `/xrpc/sh.mschf.ratking.mailbox.subscribe` with only `recipientDid`, `leaseId` and `generation` in the query. The first JSON frame is `{ "$type": "sh.mschf.ratking.mailbox.subscribe#auth", "token": "<fresh service-auth JWT>" }`. Its issuer must be the recipient and its `lxm` must be the subscribe NSID. The normal signature, audience, expiry and replay checks apply. Successful authentication emits exactly one notice with the current watermark, atomically with marking the socket authenticated. This first notice is the ready and catch-up barrier: clients wait for it before listing. Every later committed append emits its own notice, so appends racing authentication are either included in the barrier or announced after it. Tokens never belong in URLs or persisted socket attachments.

Hibernatable sockets use `acceptWebSocket`, lifecycle attachments and DO alarms for the five-second authentication deadline. After each committed append, an authenticated holder receives `{ "$type": "sh.mschf.ratking.mailbox.subscribe#notice", "seq": 1 }`, with no sender, TID or content. Catch up through list's exclusive `afterSeq`. A newer generation or release closes the old sockets; expiry closes them at the next notice. Close codes are `4408` for authentication timeout, `4401` for authentication failure and `4409` for a stale lease. Hibernation preserves attachments; owner migration requires reconnecting.

## DID registration

`admin.putDidDocument` allows only issuers in `OPERATOR_DIDS`, an optional JSON array that defaults to `[]`. It stores the public document in the DO named by its ID. Identical repeats return the DID; different documents fail with `DocumentConflict`. Static `DID_DOCUMENTS` cannot be overridden. Key rotation is not available in this version.

## Name issuer

One global Issuer DO (`ISSUER`, instance `issuer`, added by migration `v2`) lets enrolled hosts register Pi names without the operator key. It serves three generated methods under `sh.mschf.ratking.identity`:

- `enrollHost`: operator-only (`OPERATOR_DIDS`). Stores the host DID and registers its public document create-only, exactly as `admin.putDidDocument` does, so the host's service-auth JWTs resolve.
- `register`: `{ name, document } → { did }`. The caller must be an enrolled host. The name must match pi-ratking's grammar and must not be in `ISSUER_RESERVED`. The document id must equal the DID derived from `ISSUER_DID_TEMPLATE` (`{agent}` replaced by the name, `/` by `.`). The document must be a bare public-key document: any extra field, private JWK field included, is refused. The first enrolled host to register a name owns it. An identical repeat by that host returns the same DID; any other registration of the name returns `NameTaken`. The issuer writes the document into the DID's Mailbox DO before binding the name, then rechecks the binding in the same transaction that writes it. A Mailbox DO that already holds a different document returns `DocumentConflict` and the name stays free.
- `listNames`: any authenticated caller pages `{ name, did, document }` by name, 100 per page.

Policy is pure (`src/issuer-policy.ts`); storage is DO SQLite (`src/issuer-store.ts`). `ISSUER_DID_TEMPLATE` is required; without it, or with a malformed `ISSUER_RESERVED` JSON array, `register` answers `MailboxUnavailable`. Names registered through `admin.putDidDocument` are not in the issuer's directory. There is no revoke or transfer route.

## Hosted mailbox loop

Use `src/hosted-worker.ts` to compose Mailbox, AuthTokens and Agent in one Worker. Bind `AGENT` to its Agent class, add Agent to the SQLite migration, and set `HOSTED_AGENTS` to a JSON array of hosted DIDs. The mailbox-only entry remains available without agent bindings. The mailbox app imports the agent-runtime port and composition adapter, never pi-durable.

After a successful authenticated send, the Worker best-effort calls the hosted recipient's private `wake()` RPC. Separate `wake_attempts` rows record accepted or unavailable; they never change delivery state. An accepted wake means the agent accepted work, not that it answered. Replaying an admitted envelope can wake the agent again, but returns its original admission receipt.

The agent acquires a mailbox lease through the same authority. If another holder owns it, that wake does no processing and the next wake retries. It reads every page of one list snapshot, folds receipt events, and processes only accepted, queued or delivered messages. It renews before injection and acknowledgment. Listing itself still does not deliver anything. The agent opens and verifies envelopes inside the isolate, submits through AgentHarness, delivers its signed reply through the same XRPC authentication and routing handler as the CLI, then acknowledges the original. The reply's encrypted signed payload contains `replyTo`. Reply delivery uses same-Worker DO stubs, never an outbound HTTP call.

See [agent-runtime](../../packages/agent-runtime/README.md#hosted-mailbox-loop) for configuration, checkpoints, model egress restrictions and limits. Production has no evidence route.

## Checks

`pnpm check` runs workspace typechecks and the strict stack gates. `pnpm test` runs the retained local suites.

The manual configured-target and celld qualification suites were retired. There is no current runner for those proofs. Cloudflare adapter qualification remains undone.

## Local runtime provenance

celld v0.6.1, arm64 macOS asset: `https://github.com/denoland/celld/releases/download/v0.6.1/celld-aarch64-apple-darwin.gz`

Release SHA-256 (compressed asset): `3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95`

The generated server's runtime `@atproto/lexicon` dependency bundled and initialized successfully on celld. ES256 service auth uses `crypto.subtle.importKey('jwk')` and `crypto.subtle.verify` with ECDSA P-256/SHA-256 inside celld. A bundle-graph test confirms the test Worker includes the envelope compatibility adapter; HPKE is no longer forbidden in Worker graphs.

The v0.6.1 isolate has two P-256 WebCrypto defects: raw public export returns 91-byte SPKI instead of 65-byte SEC1 (`crates/celld/js/crypto.js:339-344`), and raw ECDH public import is unsupported (`crypto.js:254-327`). The envelope package applies instance-local, guarded serialization/import adapters, including an on-curve check before JWK import. `/test/p256-raw` still reproduces the original 91-byte export. `/test/hpke/open` opens a Node-sealed envelope; `/test/hpke/seal` seals a reply that Node opens and verifies. The retired real-node proof checked both directions. These routes exchange ephemeral proof keys over loopback only and never enter the production Worker. No suite, AAD, signing-byte, wire-version or pin changes. Crypto remains **unreviewed**; see the envelope README for repros, source locations and removal conditions.
