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

Stage files from a private mode-0700 directory outside the checkout. Give the selected inventory SSH user a mode-0700 `rat-king-pds-stage` directory. Use a mode-0600 `RATS_NEST_INSTANCE` inventory and the non-secret inputs `RAT_KING_PDS_NODE`, `RAT_KING_PDS_HOSTNAME`, `RAT_KING_PDS_PORT`, `RAT_KING_PDS_COMMIT`, `RAT_KING_PDS_PLC_PUBLIC_KEY`, and `RAT_KING_PDS_SNAPSHOT_RECIPIENT`. Set the last one to the approved native `age1…` X25519 public recipient, not a fixture. The private identity never belongs on the PDS host, in the render, or in Alchemy state. Omit `RAT_KING_PDS_TUNNEL_ID` to stage no ingress file.

```sh
ALCHEMY_TELEMETRY_DISABLED=1 "$CHECKOUT/node_modules/.bin/alchemy" plan --stage pds "$CHECKOUT/stacks/pds/stack.ts"
```

After staging approval, run the same command with `deploy`. Verify remote staged files against the reviewed render. Alchemy does not install, start, or enable anything.

Perform the loopback install in this order:

1. Create the fixed, non-login `pds` system user with primary group `pds`. Do not add it to the restic reader's group.
2. Mount `/data` with root-controlled real ancestors. Create `/data/pds` and `/data/pds-snapshots` as `pds:pds 0700`. Create the separate ciphertext export `/data/pds-snapshot-archives` as `pds:$BACKUP_READER_GROUP 2750`. Never grant the backup reader access to live or plaintext data. Reserve space for seven encrypted generations, a new encrypted file, one private generation and SQLite scratch.
3. Install the official [FiloSottile age v1.3.1 Linux amd64 static release](https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-linux-amd64.tar.gz). Verify the tarball SHA-256 `bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377`. Install its `age/age` member as `/usr/local/bin/age`, `root:root 0755`. Verify the installed binary SHA-256 `2e305637f2a0555305e21c17fb74446acbb39b53135d43d4b744e50c287133a5`. Snapshots use Node's `node:sqlite` backup API and GNU `/usr/bin/tar`; no SQLite CLI or package installation is required.
4. Verify pinned Node 24.22.1 at `/usr/local/bin/node`, GNU tar and age, their resolved targets and every ancestor are root-controlled with no non-root write grants. Build the exact release checkout's `runtime/` with Node 24.22.1 and `npm ci --omit=dev`. Verify the `better-sqlite3` native addon against the target ABI, OS and architecture. The host owner verifies the runtime tarball SHA-256, then installs it into `/opt/rat-king-pds/releases/<commit>` (`root:root`, directories `0755`, files `0644`). Check symlink targets, ancestors and ACLs for non-root writes or escapes. Keep the previous pinned release.
5. The credential owner installs the origin credential files using the reviewed credential script. Verify `/etc/credstore` is a real `root:root 0700` directory, with `root:root 0600` files: `rat-king-pds.jwt-secret`, `rat-king-pds.admin-password`, and `rat-king-pds.plc-rotation-key`. The PLC scalar is 32 bytes in 64 hex characters with no prefix; the separate compressed public pin is 66 lowercase hex characters beginning `02` or `03`. Startup rederives the pin before serving. Keep the scalar sealed offline. Never put sensitive values in shell environment, logs, staged files or Alchemy state.
6. Install the reviewed origin and snapshot units into `/etc/systemd/system` and reload systemd. Run `systemd-analyze security rat-king-pds.service rat-king-pds-snapshot.service` and keep both exposure scores with the release SHA. On loopback authorization, start only the origin. Verify `/xrpc/_health` and the release header (request `/.well-known/did.json` with the PDS host header), and ensure `ss -ltnp` reports only `127.0.0.1:2583` for the PDS; verify direct network access from another host fails. Leave the connector, public route and PLC egress drop-in absent.
7. Start `rat-king-pds-snapshot.service` once manually against the empty initialized origin. Check the origin returns to loopback health and the approved backup reader can read the completed ciphertext, but not the plaintext or live data. Record its SHA-256 independently and back up the ciphertext with restic.
8. Perform the [authenticated restore drill](#snapshot-and-restore) with the approved offline identity. Require `PDS_EMPTY_RESTORE_OK`, the authenticated restic snapshot ID and matching archive digest in the private release receipt. Do not create the first real account or open PLC egress without that receipt.
9. Only after the receipt, enable and start the snapshot timer. Wire the independent freshness check in monitoring.

### Publisher and public ingress (separate approvals)

For the first real account, get separate review of the [temporary PLC egress window](#temporary-plc-egress); the drop-in is not an install artifact. Through loopback, create one single-use admin invite (`com.atproto.server.createInviteCode`). Use `com.atproto.server.createAccount` with that invite, the agreed handle and an independent offline recovery `did:key` in `recoveryKey`; omit `did` and `plcOp`. Confirm the PLC document has the expected handle, repo key and HTTPS endpoint. Check the PLC audit log for the independent recovery key before recording the publisher DID. Save credentials privately and close egress after the approved operation. Publish via authenticated loopback `com.atproto.repo.putRecord`, then record the URI and CID from unsigned `com.atproto.repo.getRecord`.

For public launch, require the populated off-host restore receipt and dependency sign-off for the exact lock (`npm audit --omit=dev`). With separate public approval, verify the pinned, host-approved cloudflared binary at `/usr/local/bin/cloudflared` (`root:root 0755`; fixture validated with 2026.11.2). Use a separate connector-only `rat-king-pds.tunnel.json` credential, not a zone-wide certificate or token in argv. Install the reviewed `ingress.yml` at `/etc/rat-king-pds/ingress.yml` (`root:root 0644` in a `root:root 0755` directory). Validate the allowed and denied rules with cloudflared, save the connector's `systemd-analyze security` score, then start it and attach the exact DNS route. From outside, verify the service DID, exact `getRecord` URI/CID, `subscribeRepos` upgrade, and handle and authority TXT records. Verify 403 for admin, invite and write RPCs and a 404 fallback for other hosts. Stop the connector if any public proof disagrees.

| System unit | ExecStart and custody | Resource caps |
| --- | --- | --- |
| `rat-king-pds.service` | Pinned Node runs `<release>/supervisor.ts <control-socket> <hostname> <port> /data/pds <commit> <PLC-public-pin>` as `User=pds`. Three credentials; only data and the private runtime socket directory are writable. `PDS_EMAIL_SMTP_URL` is explicitly unset. | 768 MiB high / 1 GiB max, 1 CPU, 64 tasks |
| `rat-king-pds-snapshot.service` | Pinned Node runs `<release>/snapshot.ts snapshot <control-socket> <data> <private-scratch> <ciphertext-export> <age-recipient> /usr/local/bin/age` as `User=pds`. It can read, not write, `/data/pds`, and can use Unix sockets only (`IPAddressDeny=any`). `ExecStopPost` runs `snapshot.ts recover <control-socket>` as the same user and waits for origin readiness. | 512 MiB max, 1 CPU, 32 tasks, 30-minute copy timeout |
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

After the supervisor acknowledges the copy and the restarted origin is ready, the job streams the finished private generation from GNU tar directly into `age -r <recipient>`. It never writes a plaintext tar file. Both processes must succeed. The job syncs the ciphertext and checks its byte count and SHA-256 against the age stream then deletes that plaintext generation before atomically publishing `YYYY-MM-DD.tar.age` at mode `0640` with the export directory's inherited reader group. It also cleans up on handled failures. It retains only ciphertext for seven Pacific calendar dates. Read-back verifies the stored bytes, not decryption or provenance. After interruption, investigate abandoned `.partial-*` paths; they are not backups. Keep the snapshot unit at `UMask=0077`. As the actual backup reader, verify access to ciphertext only and no write access to either tree.

Configure restic to include only completed `YYYY-MM-DD.tar.age` files at the top of `/data/pds-snapshot-archives`, not `.partial-*` or any other tree. Verify the remote restic snapshot exists. The age identity stays with the offline credential custodian; keep the sealed PLC rotation credential and account custody separate. Before enabling the timer, run the service manually and check the origin comes back. Run the freshness command from monitoring as the backup reader, independently of the timer and `Requisite`:

```sh
/usr/local/bin/node "$RELEASE/snapshot.ts" snapshot-age /data/pds-snapshot-archives 26
```

Alert on nonzero exit: the newest completed archive is absent, stale, future-dated or invalid as an export file. The 26-hour window allows the Pacific fall-back hour and copy time. A fresh result does not prove decryptability or off-host delivery; keep those as separate checks.

Run this drill twice: with the empty origin **before the first real account**, and with the published Lexicon **before public launch**. Record the expected archive SHA-256 on the source independently before backup. Restore only from the configured, authenticated off-host restic repository. Match its repository ID and the approved snapshot ID from the backup receipt, then select the exact archive path in that snapshot. Do not use a loose `.tar.age`, even if it decrypts: age confidentiality does not prove who made the archive.

```sh
restic restore "$RESTIC_SNAPSHOT_ID" --include "$ARCHIVE_REPO_PATH" --target "$PRIVATE_RESTORE_TARGET"
```

Transfer only that recovered ciphertext to the dedicated offline drill machine. The custodian opens the approved age identity for this run only on a private input descriptor (`3` below); never save it on disk or place it in argv or logs. Do not decrypt on the PDS or backup reader. Run as a dedicated non-root user in Bash with a private scratch directory and the pinned release:

```sh
set -e -o pipefail
umask 077
DRILL_DIRECTORY=$(mktemp -d)
mkdir -m 0700 "$DRILL_DIRECTORY/generation"
printf '%s  %s\n' "$EXPECTED_ARCHIVE_SHA256" "$RESTORED_ARCHIVE" | sha256sum --check --status &&
  age -d -i - -o "$DRILL_DIRECTORY/decrypted.tar" "$RESTORED_ARCHIVE" <&3 &&
  tar --no-same-owner --no-same-permissions -xf "$DRILL_DIRECTORY/decrypted.tar" -C "$DRILL_DIRECTORY/generation" || exit 1
exec 3<&-
```

Stop on any failure. The restore helper checks the snapshot manifest marker and boots a private copy on loopback with throwaway credentials and a loopback PLC refusal endpoint. Before the first real account, run `node "$RELEASE/restore.ts" --empty "$DRILL_DIRECTORY/generation"` and require `PDS_EMPTY_RESTORE_OK version=0.5.65 repos=0`. Before public launch, run `node "$RELEASE/restore.ts" "$DRILL_DIRECTORY/generation" "$PUBLISHER_DID" "$LEXICON_NSID" "$EXPECTED_CID"`. Require `PDS_RESTORE_OK` with the independently recorded Lexicon CID from an unsigned read. These are boot/read checks, not tests of live PLC writes. Keep the release SHA, restic repository and snapshot IDs, matching archive digest and restore receipt privately. Close the identity descriptor and clean up the decrypted tree under the custodian's procedure. It does not modify live data. A real disaster restore requires separate approval and verified ownership, then reuses the original repo signing keys and PLC custody; do not mint a replacement account under the same authority.

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
