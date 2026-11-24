# Rat King public edge: slice 1

The public edge uses one desk peon Durable Object and one contact-session Durable Object per external session. The identity edge has an Alchemy `public-edge` stage for the `ratking.dev` Cloudflare zone. Account IDs, credentials, DNS records, and deployment authority stay outside this repository.

## Bridge and sessions

Each desk peon owns a desk's public face. Eventually it can answer, queue and relay a contact's mail to the real desk over Rat King. Each contact session keeps its own durable initialization, public desk alias and derived prompt/tool scope. The lifecycle is **unopened → active → closed**: successful MCP initialization opens it; termination closes it. Reconnects replay sanitized initialization into a fresh MCP runtime, not a cached credential. Sessions expire after 24 hours.

The `DeskPeon` and `ContactSession` skeletons expose no model calls or live mailbox writes. All tiers have only `about`, `tiers`, `verifyInvite` and `whoami`. The current credential, authority freshness and invite are checked again on each contact request. Stored scope is descriptive, never authority. Trust remains data for the existing attention judge, not a second judge. The future execution boundary can reuse the agent Durable Object direction in `packages/agent-runtime`; this slice imports no model runtime.

For the peon's **edge → mailbox relay hop**, recommend an outbound-pulled queue relay: the peon retains encrypted envelopes and the mailbox relay pulls authorized jobs and acknowledges delivery idempotently. This avoids public mailbox ingress and lets each desk pause its bridge. Risks: duplicate delivery, delayed revocation, ordering, queue retention, compromised relay credentials and operational backlog. Require envelope IDs, recipient-side deduplication, bounded retention and fresh invite checks at dequeue. A Cloudflare Tunnel would be simpler but couples ingress to host availability. A Cloudflare mailbox instance removes that hop but adds mailbox/storage migration and another authority boundary. Neither alternative is implemented.

## Identity edge (A1)

The same Worker serves the board-service DID at `ratking.dev/.well-known/did.json` and agent DIDs at `<agent>--<project>.ratking.dev/.well-known/did.json`. The issuer must register each DID, including the apex. An unknown DID or a two-level DID host returns 404. A claimed `<agent>.<project>.ratking.dev` handle resolves to the DID in plain text at `/.well-known/atproto-did`. The DID document lists that handle as an `at://` alias. Publish an `_atproto` TXT record for a two-label handle. Its HTTPS fallback also needs a proxied record and a certificate covering that hostname; the zone's `*.ratking.dev` certificate alone does not cover it.

Account and handle reservations use Domain on Durable Object SQLite. A handle can change, but its first DID permanently reserves it in A1. The old handle stops resolving immediately, and a retired account loses its handle. The edge verifies that a reservation still matches the Account before resolving it. If a claim stops after the reservation commits, only the same DID can finish it. The pure TXT plan lists the current records (`_atproto.<handle> TXT "did=<DID>"`); it does not apply or delete records.

Keys are public Multikeys. Publish the first key for a purpose; use rotation to replace it. Key material cannot be reused for another purpose or reinstated after rotation. The current AT signing key gets the standard `#atproto` alias. Every key also has a permanent, numbered method ID. Signatures that need historical verification must use that numbered ID, not the moving alias. Rotation and retirement leave historical key material in the DID document with `rotatedOutAt` (Unix milliseconds) and remove it from active relationships. The retired DID document stays available. A1 does not advertise a PDS; it does not provision an AT repository.

### Issuer writes

Configure `RATKING_IDENTITY_ISSUER` as JSON with `did` and a **public** P-256 JWK in `key`. The edge has no issuer private key. If the pin is absent, writes are disabled. The contact trust directory cannot authorize identity writes.

Send `POST https://ratking.dev/identity/admin` with JSON `{ "payload": "<serialized JSON>", "signature": "<base64url ES256 signature>" }`. Sign the UTF-8 bytes of `ratking.identity.admin.v1`, a NUL byte, then the exact payload string. Use the 64-byte IEEE P1363 signature, not a DER sequence. The payload contains:

- `issuer`: the pinned DID; `audience`: `did:web:ratking.dev`; `did`: the target account.
- `issuedAt` and `expiresAt`: Unix milliseconds, with a lifetime of at most five minutes.
- `nonce`: a fresh 32-character lowercase hex value. Resend the same signed payload when retrying. Domain deduplicates committed commands by payload digest, so a retry cannot reapply an old mutation. A handle claim retried after retirement can be refused.
- `mutation`: an object tagged with `_tag`. `Register` and `Retire` take no other fields. `ClaimHandle` takes `handle`. `PublishKey` and `RotateKey` take `key: { purpose, publicKeyMultibase }`. Signing purposes accept P-256 or secp256k1, `encryption` accepts P-256 or X25519, and `kem` accepts ML-KEM-768.

The identity zone serves only DID and handle reads and apex issuer writes. Other paths on `ratking.dev` and its subdomains return 404 if they reach this Worker. The board and PDS paths are not part of this Worker.

### Deploy `public-edge`

The release operator needs approval for this stage, the approved commit, and access to the **account that owns `ratking.dev`**. Use the same checkout and private Alchemy state for plan and apply. Keep the stage env file, credentials, and `.alchemy` state out of Git. `workers.dev` and version previews stay off.

1. Inventory the zone's Worker Routes and Worker Custom Domains. Stop if the apex is already assigned to an origin whose traffic must be preserved, or if a desired route pattern conflicts with an unmanaged route. Record the board's current custom domain target and a read-only response baseline from a board path. Record the PDS and tenant baselines if already live. Do not use `--adopt` to resolve conflicts.
2. Ensure the apex and wildcard resolve through Cloudflare's proxy. For names with no origin, the release operator can create proxied `AAAA` placeholder records for `ratking.dev` and `*.ratking.dev` pointing at `100::`. Do not replace existing records or change the board's Custom Domain, PDS Tunnel or their DNS. Check the wildcard certificate for agent hosts. For Joel's handle, ensure an explicit proxied `joel.people.ratking.dev` record and an active edge certificate covering that full name before testing HTTPS. The deployed stack does not create DNS records or certificates.
3. Set `EDGE_PROFILE` to the Alchemy auth profile connected to the zone's Cloudflare account (account Workers Scripts edit; zone read and Workers Routes edit). Keep provider credentials in the operator's credential store, not the stack or seed config. In the private env file selected by `EDGE_ENV_FILE`, set `RATKING_ZONE_CLOUDFLARE_ACCOUNT_ID` to the independently verified zone-owning account and `RATKING_COMMIT` to the full approved commit SHA. Set `RATKING_IDENTITY_ISSUER` to `{ "did": "…", "key": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" } }` using the public **signing** JWK from the mailbox command issuer's public document. Never set `d` or lease the private identity into the deployment. The stage refuses an absent pin. `RATKING_PUBLIC_DESK` and `RATKING_TRUST_DIRECTORY` are optional existing edge settings; omit them unless configured for this stage.
4. Set `RATKING_ADDITIONAL_CUSTOM_DOMAINS` to a JSON array of all other existing `ratking.dev` subdomain Custom Domain hostnames, or `[]` after checking that there are none. No-script exclusions for `board.ratking.dev`, `pds.ratking.dev`, and `*.pds.ratking.dev` are unconditional. Reserve the apex for the identity edge. Add a new Custom Domain's exact exclusion before bringing that domain live. Do not remove a bypass while its origin still needs protection.

From the repo root:

```sh
pnpm exec alchemy plan --detailed --profile "$EDGE_PROFILE" --stage public-edge --env-file "$EDGE_ENV_FILE" apps/ratking-sh/alchemy.run.ts
pnpm exec alchemy deploy --profile "$EDGE_PROFILE" --stage public-edge --env-file "$EDGE_ENV_FILE" apps/ratking-sh/alchemy.run.ts
```

Review the plan before applying. Expect the edge Worker and its Durable Objects, `ratking.dev/*` and `*.ratking.dev/*` targeting that Worker, and the more-specific routes below with **no script**. The wildcard depends on the bypass routes, so they are installed first. No DNS, Tunnel, Custom Domain, board Worker, or PDS changes should appear. Read the applied route table back after deploy.

| More-specific route                   | Script | Origin stays in charge     |
| ------------------------------------- | ------ | -------------------------- |
| `board.ratking.dev/*`                 | none   | Board Worker Custom Domain |
| `pds.ratking.dev/*`                   | none   | PDS Tunnel                 |
| `*.pds.ratking.dev/*`                 | none   | Tenant PDS Tunnel          |
| Each additional exact hostname + `/*` | none   | Existing Custom Domain     |

[Cloudflare's route rules](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior) put routes before origins, including Custom Domains. The most specific matching route wins; a route with no script negates the less specific wildcard and leaves the origin in charge. The workerd test deploys these declarations and verifies that board, PDS, tenant, and additional origins still respond from the origin, while the wildcard serves Joel's DID and handle. This is emulated provider proof, not a substitute for live DNS, TLS, and origin readback.

### Seed and verify

On the operator host that already holds the mailbox command issuer, export `RATKING_IDENTITY_ISSUER` to the deployed public pin and `RAT_KING_OPERATOR_IDENTITY` to the issuer's existing secret **name**. Prepare an external public seed plan with `{ "apexKeys": [] }`. If the apex has approved keys, fill `apexKeys` with `{ "purpose": "…", "publicKeyMultibase": "…" }` objects. An empty array registers the apex without new keys. The people DID is deliberately keyless: the board maps Joel by session, not by a DID key.

```sh
bash apps/ratking-sh/edge.sh seed "$EDGE_SEED_PLAN"
```

The launcher pipes the short-lived issuer lease into the local signer. The private signing JWK is never sent to Cloudflare. The signer checks the pin, signs the A1 `Register`, `PublishKey` (if supplied) and `ClaimHandle` commands, and reads both documents back. It claims `joel.people.ratking.dev`. It can resume from a partial run by reading existing state; it does not rotate keys or change an existing different handle. A conflict stops the run. Output goes to `${XDG_STATE_HOME:-$HOME/.local/state}/rat-king/public-edge/seed.log` without key material or signed payloads. Use a synchronized operator clock and run only one seed at a time.

After the claim, publish the DNS-only TXT `_atproto.joel.people.ratking.dev` with `did=did:web:joel--people.ratking.dev` for AT Protocol DNS resolution. Verify signed out, without following redirects or suppressing TLS validation:

```sh
curl -fsS https://ratking.dev/.well-known/did.json \
  | jq -e '.id == "did:web:ratking.dev"'
curl -fsS https://joel--people.ratking.dev/.well-known/did.json \
  | jq -e '.id == "did:web:joel--people.ratking.dev" and .alsoKnownAs == ["at://joel.people.ratking.dev"] and .verificationMethod == []'
test "$(curl -fsS https://joel.people.ratking.dev/.well-known/atproto-did)" = 'did:web:joel--people.ratking.dev'
dig +short TXT _atproto.joel.people.ratking.dev
```

Require HTTP 200 on all three GETs and the exact TXT value. Compare board and PDS/Tunnel probes with their predeploy baselines. Close the release only after the Worker version, commit binding, route table, and public responses match.

### Rollback

Before apply, record the active Worker version (if any), script name, and route table. For a bad bundle, use Cloudflare's Worker Deployments page to roll back to the recorded known-good version at 100% without rebuilding; verify its exact version and the public outputs again. A version rollback does not revert routes, DNS, or Durable Object data. If the new routing broke existing origins, disable the `IdentityWildcard` route first and keep its bypasses. On a first deploy with no previous bundle, remove only this stage's two script-bearing routes; leave the Worker and Durable Objects intact. Verify the board/PDS baselines and reconcile Alchemy state before the next deploy. Do not destroy the stack or remove origin bindings. The seed's handle reservation is durable; rollback does not release it. Remove an incorrect DNS TXT separately and have the issuer correct the identity rather than deleting storage.

## Admission and limits

Lexicon records are atproto-compatible data. ES256 signs domain-separated DAG-CBOR records; these detached signatures are not atproto repository-commit proofs. Messages never go on atproto. Tier 1 proves a key fingerprint, not a claimed DID. Tier 2 requires a separately verified DID/handle binding; tier 3 requires an authorized fleet issuer, exact namespace/recipient scope, subject-key binding, expiry and an authoritative revocation snapshot. Tier 4 requires a host-issuer attestation. No public key supplied by a caller becomes a trusted issuer. The optional deployment-supplied trust directory must be current; missing/stale authority cannot issue a vouch. Its operator must verify DID keys and handle resolution before adding attestations. Network DID resolution is not implemented.

MCP hosts need OAuth next: authorization-server discovery, audience-bound short-lived access tokens, PKCE, consent and per-organization grants. Keep organization grants separate from trust and invite scope; intersect all three. Do not treat a legacy session ID as a grant. This slice accepts five-minute signed bearer identity proofs for read-only inspection, not mail authorization.

Ingress limits MCP to **30 requests/IP/minute** and **64 KiB/request**. Cloudflare counts the IP limit per location, not globally. Future peons must enforce invite rate and per-subject, organization and recipient quotas before queueing and again before relay; use durable counters for global enforcement. Until a verified invite explicitly permits otherwise, **outbound fleet mail to `ext/*` needs Joel's approval**. Slice 1 enables no outbound mail at any tier.
