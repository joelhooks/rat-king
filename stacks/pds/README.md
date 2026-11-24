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

Use an outbound, locally managed [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). It can serve the required custom HTTPS hostname without a WAN listener or inbound firewall hole. Cloudflare terminates public TLS and sees the admitted traffic. The operator owns the zone, connector lifecycle and a separate tunnel credential. Use the exact host and the staged allowlist: service and handle DID lookups, health, repo reads and sync (including the WebSocket firehose). Same-host paths outside the allowlist get 403; other hosts get 404. Do not publish the connector metrics endpoint. No public OAuth, login, signup, invite creation, admin API, repo writes or app-view proxy. Public GETs and the firehose must not require a Cloudflare Access cookie or challenge. Bypass edge caching for XRPC and verify that the connector supplies the actual client address to the origin's trusted loopback proxy.

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) also avoids an inbound hole and is simpler for a disposable service. Its public TLS hostname is a tailnet name, not the custom domain the PDS advertises, and it imposes port and bandwidth constraints. It does not replace the exact-host ingress allowlist. Do not put both paths in front of the origin.

## Stage and install (private operator runbook)

1. Reserve `127.0.0.1:2583` and a fixed, non-login `pds` system user with primary group `pds`. Mount `/data` with root-controlled real ancestors. Create `/data/pds` and the plaintext scratch directory `/data/pds-snapshots` as `pds:pds` mode `0700`. Separately create `/data/pds-snapshot-archives` as `pds:$BACKUP_READER_GROUP` mode `2750`. Use the existing restic reader's group; do not add `pds` to it. Only ciphertext enters the group-readable tree. Reserve space for seven encrypted generations, one new encrypted file, a private plaintext generation and a temporary per-database copy. Never grant the backup reader access to the live or plaintext trees.
2. Pin and checksum-verify Node 24.22.1 and the host-approved cloudflared release. The rule fixture was verified with cloudflared 2026.11.2. Install `/usr/local/bin/node` and `/usr/local/bin/cloudflared` as `root:root` mode `0755`; install the distro's SQLite CLI, GNU tar and age at `/usr/bin/sqlite3`, `/usr/bin/tar` and `/usr/bin/age`. Verify those executables and their resolved targets are also root-controlled. Verify the binaries, resolved targets and all ancestors are root-controlled with no non-root write grants. Do not install a unit pointing at a user-managed binary or a temporary directory. From a clean checkout of the candidate SHA, build `runtime/` with the exact Node pin and `npm ci --omit=dev`. Verify the `better-sqlite3` native addon against the target ABI, OS and architecture. Package the runtime and `node_modules`; the host owner verifies the tarball SHA-256 before installing into `/opt/rat-king-pds/releases/<commit>` (`root:root`, directories `0755`, files `0644`). Resolve any symlinks and check for escapes and non-root write grants, including on ancestors. Keep the previous pinned release. Review `npm audit --omit=dev` of the exact lock before exposing anything.
3. The credential owner verifies `/etc/credstore` is a real `root:root` directory at mode `0700` and installs `root:root` mode `0600` files: `rat-king-pds.jwt-secret` (at least 32 random bytes encoded as text), `rat-king-pds.admin-password` (strong, at least 32 characters), and `rat-king-pds.plc-rotation-key` (valid secp256k1 scalar, 32 bytes in 64 hex characters, no prefix). `LoadCredential=` supplies these to the PDS without shell environment or Alchemy state. Keep a sealed offline copy of the scalar. Verify and supply the separate compressed public key (66 lowercase hex characters, beginning `02` or `03`) as an operator input; startup rederives it before opening the origin. The PDS signs PLC operations locally; it does not send the scalar to PLC. The connector uses a separate `rat-king-pds.tunnel.json` credential when approved; do not use a zone-wide certificate file or a token in argv.
4. Give the selected inventory SSH user a mode-0700 `rat-king-pds-stage` directory under its inventory home. Run Alchemy from a private 0700 working directory outside the checkout. Use the `RATS_NEST_INSTANCE` mode-0600 inventory and these non-secret settings: `RAT_KING_PDS_NODE`, `RAT_KING_PDS_HOSTNAME`, `RAT_KING_PDS_PORT`, `RAT_KING_PDS_COMMIT`, `RAT_KING_PDS_PLC_PUBLIC_KEY`, and `RAT_KING_PDS_SNAPSHOT_RECIPIENT`. The last is the native `age1…` X25519 public recipient approved by the credential owner. Verify its checksum by exercising encryption and confirm independently that the offline custodian can decrypt with the corresponding identity. The age private identity never belongs on the PDS host, in the render, or in Alchemy state. Omit `RAT_KING_PDS_TUNNEL_ID` to stage **no** `ingress.yml`; when assigned, it is the tunnel UUID, not a credential. Run from the private working directory, using the installed CLI from the checkout:

   ```sh
   ALCHEMY_TELEMETRY_DISABLED=1 "$CHECKOUT/node_modules/.bin/alchemy" plan --stage pds "$CHECKOUT/stacks/pds/stack.ts"
   ```

   Only after reviewing the plan and receiving staging authorization, run the same command with `deploy` instead of `plan`. Verify the remote staged files against the reviewed render. Alchemy can write the staged files only; it never runs systemctl or contacts Cloudflare.

5. The host owner reviews all unit files, installs the origin and two snapshot units into `/etc/systemd/system`, and reloads systemd. Run `systemd-analyze security rat-king-pds.service rat-king-pds-snapshot.service` and record both exposure scores with the release SHA; repeat for `rat-king-pds-tunnel.service` if installed. Treat the scores as receipts, not as runtime tests. Do not install or start the connector or attach a DNS route until separately approved. On loopback authorization, start the origin only. Confirm the health version, release header (send `Host: pds.ratking.dev` on loopback), and `ss -ltnp` reporting exclusively `127.0.0.1:2583`; probe from another host to prove that direct network access fails. Verify admin and publisher credentials never enter shell history, curl argv, logs, Alchemy or the staged files. Use a private HTTP client to inject authorization headers. The launcher requires an invite, enables upstream rate limits, disables repo imports and keeps upstream's default blob cap (5 MiB). It configures no SMTP, relay notification, app view or public proxy targets.
6. Do not create the first real account until the encrypted snapshot path and offline decryption are verified. Real PLC signup **will not work in steady state**. Open a [reviewed temporary PLC egress window](#temporary-plc-egress). Through loopback, create one single-use admin invite (`com.atproto.server.createInviteCode`). Use `com.atproto.server.createAccount` with that invite, the agreed handle and an independent offline recovery `did:key` in `recoveryKey`; omit `did` and `plcOp`. Confirm the new PLC document has the expected handle, repo key and exact HTTPS PDS endpoint. Inspect the PLC audit log for the independent recovery key before recording the publisher DID. Save account credentials privately. Close the egress window after the approved operation and PLC verification. Publish via authenticated loopback `com.atproto.repo.putRecord`, then record the URI and CID from unsigned `com.atproto.repo.getRecord`.
7. After restore evidence and dependency sign-off, and only with separate public approval, install the reviewed `ingress.yml` at `/etc/rat-king-pds/ingress.yml` (`root:root` mode `0644` inside a `root:root` mode `0755` directory). Validate it with `cloudflared tunnel --config ... ingress validate` and `ingress rule` for approved and denied paths. Start the connector and attach the exact DNS route. From outside the network, verify the service DID, the exact `getRecord` URI/CID, `subscribeRepos` upgrade, the handle TXT, then the authority TXT. Verify 403 for an admin RPC, invite creation and repo writes, and 404 for a nonmatching host in the connector rules. Stop the connector if any public proof disagrees.

| System unit | ExecStart and custody | Resource caps |
| --- | --- | --- |
| `rat-king-pds.service` | Pinned Node runs `<release>/supervisor.ts <control-socket> <hostname> <port> /data/pds <commit> <PLC-public-pin>` as `User=pds`. Three credentials; only data and the private runtime socket directory are writable. `PDS_EMAIL_SMTP_URL` is explicitly unset. | 768 MiB high / 1 GiB max, 1 CPU, 64 tasks |
| `rat-king-pds-snapshot.service` | Pinned Node runs `<release>/snapshot.ts snapshot <control-socket> <data> <private-scratch> <ciphertext-export> <age-recipient>` as `User=pds`. It can read, not write, `/data/pds`, and can use Unix sockets only (`IPAddressDeny=any`). `ExecStopPost` runs `snapshot.ts recover <control-socket>` as the same user and waits for origin readiness. | 512 MiB max, 1 CPU, 32 tasks, 30-minute copy timeout |
| `rat-king-pds-snapshot.timer` | Schedules the snapshot for 01:00 Pacific, with no missed-run catch-up. | N/A |
| `rat-king-pds-tunnel.service` | `cloudflared tunnel --config /etc/rat-king-pds/ingress.yml run`; separate `DynamicUser`, requires the origin already running, credential only for this connector. | 256 MiB max, half a CPU, 32 tasks |

## Temporary PLC egress

Steady state is `IPAddressDeny=any` with loopback allowed. `https://plc.directory` and DNS are needed for real PLC mutations such as account creation, applicable handle changes and PLC key rotation. Relays dial the firehose inbound; no crawler, SMTP or app-view egress is needed. Systemd's IP ACL cannot restrict egress by DNS name.

For one approved PLC operation, the host owner reviews a **temporary** root-owned drop-in at `/run/systemd/system/rat-king-pds.service.d/90-plc-egress.conf`:

```ini
[Service]
IPAddressAllow=any
```

This permits all IP traffic from the origin cgroup during the window, not just PLC traffic. Keep the connector and public route off. Log who approved the window, the release SHA, the operation and open time in the private change record. Reload systemd, restart the origin, and confirm the loopback listener before performing the single approved operation. On success, failure or cancellation, remove that exact drop-in, reload, and restart again. Verify `systemctl cat rat-king-pds.service` no longer includes the drop-in, the effective ACL is loopback-only, and loopback health is back. Log the close time and result; do not put account credentials in the log. Never carry the drop-in in the release or leave it installed between operations.

## Snapshot and restore

The supervisor owns `/run/rat-king-pds/control.sock` in a `pds`-owned mode-0700 runtime directory. The snapshot holds a socket lease while the supervisor shuts down the reference PDS process and waits for a clean exit. With no writer alive, the snapshot copies each SQLite database and any recovery journal into writable private scratch, uses SQLite `.backup` and `PRAGMA quick_check` there, and copies regular files including actor keys and blobs. It refuses links and never writes to `/data/pds`. Expect the origin to be unavailable during the copy. A disconnect (including SIGKILL) releases the lease and starts the PDS again. `ExecStopPost` waits for it even after an interrupted copy; it cannot revoke a live snapshot's lease. An unclean child exit refuses the snapshot and fails the origin unit so systemd can restart it.

After the supervisor acknowledges the copy and the restarted origin is ready, the job streams the finished private generation from GNU tar directly into `age -r <recipient>`. It never writes a plaintext tar file. Both processes must succeed before the job atomically publishes `YYYY-MM-DD.tar.age` at mode `0640` with the export directory's inherited reader group. The job removes private scratch on normal exit and retains ciphertext for seven Pacific calendar dates. After interruption, investigate abandoned `.partial-*` paths; they are not backups. Keep the snapshot unit at `UMask=0077`. As the actual backup reader, verify access to ciphertext only and no write access to either tree.

Configure restic to include only completed `YYYY-MM-DD.tar.age` files at the top of `/data/pds-snapshot-archives`, not `.partial-*` or any other tree. Verify the remote restic snapshot exists. The age identity stays with the offline credential custodian; keep the sealed PLC rotation credential and account custody separate. Before enabling the timer, run the service manually and check the origin comes back. Run the freshness command from monitoring as the backup reader, independently of the timer and `Requisite`:

```sh
/usr/local/bin/node "$RELEASE/snapshot.ts" snapshot-age /data/pds-snapshot-archives 26
```

Alert on nonzero exit: the newest completed archive is absent, stale, future-dated or invalid as an export file. The 26-hour window allows the Pacific fall-back hour and copy time. A fresh result does not prove decryptability or off-host delivery; keep those as separate checks.

Before public launch, restore a completed ciphertext file from the authenticated off-host restic repository. Ask the custodian to decrypt on a dedicated offline drill machine, never on the PDS or backup reader. Use a private non-root scratch directory, the pinned release and the independently recorded expected CID. In Bash:

```sh
set -o pipefail
umask 077
DRILL_DIRECTORY=$(mktemp -d)
age -d -i "$OFFLINE_IDENTITY_FILE" "$RESTORED_ARCHIVE" \
  | tar --no-same-owner --no-same-permissions -xf - -C "$DRILL_DIRECTORY" \
  && node "$RELEASE/restore.ts" "$DRILL_DIRECTORY" "$PUBLISHER_DID" "$LEXICON_NSID" "$EXPECTED_CID"
```

Use only an archive from the authenticated backup repository: anyone with the public recipient can create ciphertext for it. Clean up the decrypted drill tree under the offline custodian's procedure.

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

The proof needs age and age-keygen (`/usr/bin` by default; use `PDS_PROOF_AGE_DIR` for a pinned local fixture). It kills a worker mid-copy, exercises the exact `recover` command, refuses publication on an encryption-process failure, checks missing/fresh/stale archive outcomes, and decrypts a completed archive with a throwaway offline identity before the CID restore. Expected additional receipts: `PDS_SNAPSHOT_SIGKILL_RECOVERY_OK` and `PDS_SNAPSHOT_AGE_DECRYPT_OK`. The host owner must still exercise the real units, syscall filters, mount restrictions, ciphertext-only backup reader and off-host restic restore.

The locked runtime audit reports 27 high and five moderate entries; direct high advisory groups are Nodemailer and Zod (other counts include dependent packages). SMTP is explicitly unset, but upstream still constructs a Nodemailer JSON transport. For Zod advisory `GHSA-mrhx-c7xc-m3w5`, source review found no direct public request-parse path to the affected collection validation: the admitted XRPC queries and subscription use ATProto Lexicon parameter validation, queries reject nonempty bodies, and auth/OAuth routes that parse with Zod are not admitted. The sequencer event file declares Zod schemas, but `parseRepoSeqRows` CBOR-decodes committed rows without running those schemas; the firehose cursor selects rows and does not supply event content. This is scoped to request parsing on the exact allowlist, not a proof about every indirect dependency path. Neither advisory group has an in-range automatic fix. Keep public ingress off until a dependency upgrade or an explicit reviewed mitigation clears the exact artifact. The loopback proof is not a live systemd, restic, DNS, Cloudflare edge, or public PLC test.
