# Rat King public edge: slice 1

**Recommend a desk peon Durable Object plus one contact-session Durable Object per external session.** Deploy target: **the zone's Cloudflare account**. The Alchemy stack requires stage `public-edge` and matches the resolved account against externally supplied `RATKING_ZONE_CLOUDFLARE_ACCOUNT_ID`. No account ID, credentials, DNS resource, custom-domain binding or deployment authorization lives here. Nothing has been deployed.

## Bridge and sessions

Each desk peon owns a desk's public face. Eventually it can answer, queue and relay a contact's mail to the real desk over Rat King. Each contact session keeps its own durable initialization, public desk alias and derived prompt/tool scope. The lifecycle is **unopened → active → closed**: successful MCP initialization opens it; termination closes it. Reconnects replay sanitized initialization into a fresh MCP runtime, not a cached credential. Sessions expire after 24 hours.

The `DeskPeon` and `ContactSession` skeletons expose no model calls or live mailbox writes. All tiers have only `about`, `tiers`, `verifyInvite` and `whoami`. The current credential, authority freshness and invite are checked again on each contact request. Stored scope is descriptive, never authority. Trust remains data for the existing attention judge, not a second judge. The future execution boundary can reuse the agent Durable Object direction in `packages/agent-runtime`; this slice imports no model runtime.

For the peon's **edge → mailbox relay hop**, recommend an outbound-pulled queue relay: the peon retains encrypted envelopes and the mailbox relay pulls authorized jobs and acknowledges delivery idempotently. This avoids public mailbox ingress and lets each desk pause its bridge. Risks: duplicate delivery, delayed revocation, ordering, queue retention, compromised relay credentials and operational backlog. Require envelope IDs, recipient-side deduplication, bounded retention and fresh invite checks at dequeue. A Cloudflare Tunnel would be simpler but couples ingress to host availability. A Cloudflare mailbox instance removes that hop but adds mailbox/storage migration and another authority boundary. Neither alternative is implemented.

## Identity edge (A1)

The same Worker serves the board-service DID at `ratking.dev/.well-known/did.json` and agent DIDs at `<agent>--<project>.ratking.dev/.well-known/did.json`. The issuer must register each DID, including the apex. An unknown DID or a two-level DID host returns 404. A claimed `<agent>.<project>.ratking.dev` handle resolves to the DID in plain text at `/.well-known/atproto-did`. The DID document lists that handle as an `at://` alias. Two-level handles use DNS in production; the HTTPS fallback does not imply that those hostnames have certificates.

Account and handle reservations use Domain on Durable Object SQLite. A handle can change, but its first DID permanently reserves it in A1. The old handle stops resolving immediately, and a retired account loses its handle. The edge verifies that a reservation still matches the Account before resolving it. If a claim stops after the reservation commits, only the same DID can finish it. The pure TXT plan lists the current records (`_atproto.<handle> TXT "did=<DID>"`); it does not apply or delete records.

Keys are public Multikeys. Publish the first key for a purpose; use rotation to replace it. Key material cannot be reused for another purpose or reinstated after rotation. The current AT signing key gets the standard `#atproto` alias. Every key also has a permanent, numbered method ID. Signatures that need historical verification must use that numbered ID, not the moving alias. Rotation and retirement leave historical key material in the DID document with `rotatedOutAt` (Unix milliseconds) and remove it from active relationships. The retired DID document stays available. A1 does not advertise a PDS; it does not provision an AT repository.

### Issuer writes

Configure `RATKING_IDENTITY_ISSUER` as JSON with `did` and a **public** P-256 JWK in `key`. The edge has no issuer private key. If the pin is absent, writes are disabled. The contact trust directory cannot authorize identity writes.

Send `POST /identity/admin` with JSON `{ "payload": "<serialized JSON>", "signature": "<base64url ES256 signature>" }`. Sign the UTF-8 bytes of `ratking.identity.admin.v1`, a NUL byte, then the exact payload string. Use the 64-byte IEEE P1363 signature, not a DER sequence. The payload contains:

- `issuer`: the pinned DID; `audience`: `did:web:ratking.dev`; `did`: the target account.
- `issuedAt` and `expiresAt`: Unix milliseconds, with a lifetime of at most five minutes.
- `nonce`: a fresh 32-character lowercase hex value. Resend the same signed payload when retrying. Domain deduplicates committed commands by payload digest, so a retry cannot reapply an old mutation. A handle claim retried after retirement can be refused.
- `mutation`: an object tagged with `_tag`. `Register` and `Retire` take no other fields. `ClaimHandle` takes `handle`. `PublishKey` and `RotateKey` take `key: { purpose, publicKeyMultibase }`. Signing purposes accept P-256 or secp256k1, `encryption` accepts P-256 or X25519, and `kem` accepts ML-KEM-768.

Alchemy declares the Worker on `workers.dev` and the Domain Durable Objects only. No custom domain, route, certificate, or DNS mutation is part of this slice.

## Admission and limits

Lexicon records are atproto-compatible data. ES256 signs domain-separated DAG-CBOR records; these detached signatures are not atproto repository-commit proofs. Messages never go on atproto. Tier 1 proves a key fingerprint, not a claimed DID. Tier 2 requires a separately verified DID/handle binding; tier 3 requires an authorized fleet issuer, exact namespace/recipient scope, subject-key binding, expiry and an authoritative revocation snapshot. Tier 4 requires a host-issuer attestation. No public key supplied by a caller becomes a trusted issuer. The optional deployment-supplied trust directory must be current; missing/stale authority cannot issue a vouch. Its operator must verify DID keys and handle resolution before adding attestations. Network DID resolution is not implemented.

MCP hosts need OAuth next: authorization-server discovery, audience-bound short-lived access tokens, PKCE, consent and per-organization grants. Keep organization grants separate from trust and invite scope; intersect all three. Do not treat a legacy session ID as a grant. This slice accepts five-minute signed bearer identity proofs for read-only inspection, not mail authorization.

Ingress limits MCP to **30 requests/IP/minute** and **64 KiB/request**. Cloudflare counts the IP limit per location, not globally. Future peons must enforce invite rate and per-subject, organization and recipient quotas before queueing and again before relay; use durable counters for global enforcement. Until a verified invite explicitly permits otherwise, **outbound fleet mail to `ext/*` needs Joel's approval**. Slice 1 enables no outbound mail at any tier.
