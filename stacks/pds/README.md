# Rat King PDS

This stack stages Linux system units for the reference `@atproto/pds` 0.5.65. It does not install, enable or start them, open a tunnel, write DNS, or create an account. The host owner installs from a reviewed render. The publisher is the only account in this release; writes and account administration stay on loopback.

## Identity and DNS

Use a fresh `did:plc` publisher with handle `lexicons.pds.ratking.dev`. `did:web` can identify a repo: the [reference create-account path](https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/api/com/atproto/server/createAccount.ts) accepts an existing DID with that DID's service auth, creates it deactivated, and requires the DID controller to publish the generated repo signing key and PDS endpoint before activation. Plain invite signup mints `did:plc` and writes the signing key, handle and endpoint into the PLC document. This stack uses plain signup and leaves `did:web:ratking.dev` and the apex DID document unchanged.

| Name | Owner and value |
| --- | --- |
| `pds.ratking.dev` | DNS/ingress owner: exact proxied CNAME to the assigned Cloudflare Tunnel, only after public approval. The identity edge must not intercept this hostname with a wildcard Worker route. Ensure Cloudflare can issue a certificate for the exact hostname. |
| `did:web:pds.ratking.dev` | PDS: exact-host `/.well-known/did.json` and `#atproto_pds` endpoint `https://pds.ratking.dev`. This is the **service** DID, not the publisher. The same response reports `X-Rat-King-Commit`; `/xrpc/_health` reports the PDS package version. |
| `_atproto.lexicons.pds.ratking.dev` | DNS owner: TXT `did=<publisher DID>` after signup. Do not create an HTTP handle route; the TXT record supplies verification. The identity edge must not claim the handle. |
| `_lexicon.board.ratking.dev` | Lexicon authority owner: TXT `did=<publisher DID>` after the record is publicly readable. Per the [Lexicon spec](https://atproto.com/specs/lexicon#lexicon-publication-and-resolution), reverse the namespace without its final segment, and use the **full** NSID as the record key in `com.atproto.lexicon.schema`. |

## Ingress choice

Use an outbound, locally managed [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). It can serve the required custom HTTPS hostname without a WAN listener or inbound firewall hole. Cloudflare terminates public TLS and sees the admitted traffic. The operator owns the zone, connector lifecycle and a separate tunnel credential. Use the exact host and the staged allowlist: unsigned DID, health, repo reads and sync (including the WebSocket firehose). Same-host paths outside the allowlist get 403; other hosts get 404. Do not publish the connector metrics endpoint. No public OAuth, login, signup, invite creation, admin API, repo writes or app-view proxy. Public GETs and the firehose must not require a Cloudflare Access cookie or challenge. Bypass edge caching for XRPC and verify that the connector supplies the actual client address to the origin's trusted loopback proxy.

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) also avoids an inbound hole and is simpler for a disposable service. Its public TLS hostname is a tailnet name, not the custom domain the PDS advertises, and it imposes port and bandwidth constraints. It does not replace the exact-host ingress allowlist. Do not put both paths in front of the origin.

## Stage and install (private operator runbook)

1. Reserve `127.0.0.1:2583` and a fixed, non-login `pds` system user. Use a dedicated mode-0700 data directory owned by that user on the intended storage mount. Its parent and ancestors must be real, root-controlled directories. Create a separate root-owned mode-0700 backup root with root-controlled, non-symlink ancestors and enough free space for eight copies at peak. The host owner selects the paths; do not use someone else's writable home tree as a root backup destination. The release and Node binaries must be readable outside `/home` and root-controlled, including ancestors and `node_modules`, because the root snapshot service also invokes that release. Keep the previous pinned release available.
2. From a clean checkout of the release SHA, prepare `runtime/` in a clean build directory with Node 24 (at least 24.18.0) and `npm ci --omit=dev`. Install the prepared directory, including `node_modules`, at `<release-root>/<commit>` as a root-owned immutable deployment. Build or install the `better-sqlite3` native addon for the actual Node ABI/OS/architecture; verify the addon loads before promoting. Install `sqlite3` and `systemctl` at `/usr/bin` for snapshots. Review `npm audit --omit=dev` of that exact lock before exposing anything; the current lock is not cleared for public use (see below).
3. The credential owner installs root-only 0600 files in `/etc/credstore`: `rat-king-pds.jwt-secret` (at least 32 random bytes encoded as text), `rat-king-pds.admin-password` (strong, at least 32 characters), and `rat-king-pds.plc-rotation-key` (valid secp256k1 scalar, 32 bytes in 64 hex characters, no prefix). `LoadCredential=` supplies these to the PDS without shell environment or Alchemy state. Keep a sealed offline copy of the scalar. Verify and supply the separate compressed public key (66 lowercase hex characters, beginning `02` or `03`) as an operator input; startup rederives it before opening the origin. The PDS signs PLC operations locally; it does not send the scalar to PLC. The connector uses a separate `rat-king-pds.tunnel.json` credential when approved; do not use a zone-wide certificate file or a token in argv.
4. Give the selected inventory SSH user a mode-0700 `rat-king-pds-stage` directory under its inventory home. Run Alchemy from a private 0700 working directory outside the checkout. Use the `RATS_NEST_INSTANCE` mode-0600 inventory and these non-secret settings: `RAT_KING_PDS_NODE`, `RAT_KING_PDS_HOSTNAME`, `RAT_KING_PDS_PORT`, `RAT_KING_PDS_COMMIT`, `RAT_KING_PDS_NODE_BIN`, `RAT_KING_PDS_CLOUDFLARED_BIN`, `RAT_KING_PDS_DATA`, `RAT_KING_PDS_BACKUPS`, `RAT_KING_PDS_RELEASES`, and `RAT_KING_PDS_PLC_PUBLIC_KEY`. Omit `RAT_KING_PDS_TUNNEL_ID` to stage **no** `ingress.yml`; when assigned, it is the tunnel UUID, not a credential. Run from the private working directory, using the installed CLI from the checkout:

   ```sh
   ALCHEMY_TELEMETRY_DISABLED=1 "$CHECKOUT/node_modules/.bin/alchemy" plan --stage pds "$CHECKOUT/stacks/pds/stack.ts"
   ```

   Only after reviewing the plan and receiving staging authorization, run the same command with `deploy` instead of `plan`. Verify the remote staged files against the reviewed render. Alchemy can write the staged files only; it never runs systemctl or contacts Cloudflare.

5. The host owner reviews all unit files, installs the origin and two snapshot units into `/etc/systemd/system`, and reloads systemd. Do not install or start the connector or attach a DNS route until separately approved. On loopback authorization, start the origin only. Confirm the health version, release header (send `Host: pds.ratking.dev` on loopback), and `ss -ltnp` reporting exclusively `127.0.0.1:2583`; probe from another host to prove that direct network access fails. Verify admin and publisher credentials never enter shell history, curl argv, logs, Alchemy or the staged files. Use a private HTTP client to inject authorization headers. The launcher requires an invite, enables upstream rate limits, disables repo imports and keeps upstream's default blob cap (5 MiB). It configures no SMTP, relay notification, app view or public proxy targets.
6. Through loopback, create one single-use admin invite (`com.atproto.server.createInviteCode`). Use `com.atproto.server.createAccount` with that invite, the agreed handle and an independent offline recovery `did:key` in `recoveryKey`; omit `did` and `plcOp`. Confirm the new PLC document has the expected handle, repo key and exact HTTPS PDS endpoint. Inspect the PLC audit log for the independent recovery key before recording the publisher DID. Save account credentials privately. Publish via authenticated loopback `com.atproto.repo.putRecord`, then record the URI and CID from unsigned `com.atproto.repo.getRecord`.
7. After restore evidence and dependency sign-off, and only with separate public approval, install the reviewed `ingress.yml` at `/etc/rat-king-pds/ingress.yml` (root-owned, readable by the connector). Validate it with `cloudflared tunnel --config ... ingress validate` and `ingress rule` for approved and denied paths. Start the connector and attach the exact DNS route. From outside the network, verify the service DID, the exact `getRecord` URI/CID, `subscribeRepos` upgrade, the handle TXT, then the authority TXT. Verify 403 for an admin RPC, invite creation and repo writes, and 404 for a nonmatching host in the connector rules. Stop the connector if any public proof disagrees.

| System unit | ExecStart and custody | Resource caps |
| --- | --- | --- |
| `rat-king-pds.service` | `node <release>/server.ts <hostname> <port> <data> <commit> <PLC-public-pin>`; `User=pds`, three credentials, only the data tree writable, `/home` protected. | 768 MiB high / 1 GiB max, 1 CPU, 64 tasks |
| `rat-king-pds-snapshot.service` | `node <release>/snapshot.ts snapshot <data> <backups>`; root, only data and backup trees writable apart from the private recovery marker. `ExecStopPost` resumes an origin this job quiesced. | 512 MiB max, 1 CPU, 32 tasks, 30-minute copy timeout |
| `rat-king-pds-snapshot.timer` | Schedules the snapshot for 01:00 Pacific, with no missed-run catch-up. | N/A |
| `rat-king-pds-tunnel.service` | `cloudflared tunnel --config /etc/rat-king-pds/ingress.yml run`; separate `DynamicUser`, requires the origin already running, credential only for this connector. | 256 MiB max, half a CPU, 32 tasks |

## Snapshot and restore

The snapshot briefly stops the origin to get one generation across all SQLite databases, repo signing keys and blobs. Expect an outage during the copy; schedule publisher writes, service maintenance and changes to restic around it. Don't start or stop the origin by hand while the snapshot service is running. The job writes SQLite `.backup` copies, runs `PRAGMA quick_check` on each, and copies regular files into a hidden partial directory. It refuses links. It resumes the origin before promoting the dated snapshot, and removes only older marked snapshots outside the latest seven local calendar dates. A failed or interrupted run must not be treated as a completed snapshot. Alert on service failure or absence of a fresh `PDS_SNAPSHOT_OK`; check loopback health if the service was interrupted. A forced host shutdown can leave `.partial-*` directories; investigate rather than treating those as backups.

Configure the existing restic job to back up **completed** date directories only, excluding `.partial-*`, and verify the remote restic snapshot exists. Encrypt on the origin with restic before anything leaves disk. Repo signing keys are in the actor store, so the snapshots are credentials; never sync their plaintext. Separately retain the sealed PLC rotation credential and account custody. Do not enable the timer until the host owner has exercised a manual run and checked that origin health returned.

Before public launch, restore a completed **off-host restic** snapshot into private scratch storage. Grant a dedicated non-root drill user access to the restored copy, not to the live data or live credentials. Use the same pinned release and a private scratch filesystem. Run:

```sh
node "$RELEASE/restore.ts" "$RESTORED_DATE_DIRECTORY" "$PUBLISHER_DID" "$LEXICON_NSID" "$EXPECTED_CID"
```

The script checks the snapshot marker, copies to a fresh private tree, boots only on loopback with fresh throwaway credentials and a loopback PLC refusal endpoint, and checks an unsigned read against the separately recorded CID. Expected receipt: `PDS_RESTORE_OK version=0.5.65 did=<publisher DID> nsid=<NSID> cid=<expected CID>`. This is a read/boot drill, not a test of live PLC writes. Keep the receipt and restic snapshot ID privately. It does not modify live data. A real disaster restore requires separate approval and verified ownership, then reuses the original repo signing keys and PLC custody; do not mint a replacement account under the same authority.

Rollback closes the connector and removes or disables the exact public route first. Stop/disable the origin and timer if needed. Roll back to the previous approved root-owned release only if the current SQLite format supports downgrade; never restore old data as part of a code rollback. Alchemy removal of staged files does not uninstall running services, erase data, or revoke keys.

## Local checks and public hold

```sh
pnpm exec tsc -p stacks/pds/tsconfig.json
pnpm exec tsc -p stacks/pds/runtime/tsconfig.json
pnpm exec vitest run --config stacks/pds/vitest.config.ts
(cd stacks/pds/runtime && npm ci && PDS_PROOF_EMAIL="$SYNTHETIC_EMAIL" npm run proof)
```

The host adapter has its own strict Node TypeScript config: it bridges the pinned reference library, native SQLite and systemd; the Alchemy stack and unit tests keep the Effect gates. Set `SYNTHETIC_EMAIL` to an invented address with a valid email domain. The smoke uses disposable SQLite and a loopback PLC fixture that verifies the real signed creation operation. `PDS_LEXICON_OK` and `PDS_RESTORE_OK` must report the same CID. Nothing in this test calls public PLC, creates a public account, installs a unit or sends a backup off-host.

When regenerating the runtime lock, remove incidental upstream contact addresses from optional registry metadata without changing versions, integrity hashes or package URLs. Then run a clean `npm ci` and the publication fence.

The locked runtime audit reports 27 high and five moderate entries; direct high advisory groups are Nodemailer and Zod (other counts include dependent packages). SMTP is unconfigured and auth/admin routes are not publicly forwarded, but upstream still constructs a Nodemailer JSON transport. Zod is used by the OAuth layer **and** the sequencer; the latter is on the path to public sync, so do not assume Zod is unreachable. Neither advisory group has an auto-fix within the package constraints. Keep public ingress off until a dependency upgrade or an explicit reviewed mitigation clears the exact artifact. The loopback proof is not a live systemd, restic, DNS, Cloudflare edge, or public PLC test.
