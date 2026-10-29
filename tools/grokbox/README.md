# Outbound-only bot host kit

Requires Linux, Node 24.18+, Corepack, and a Rat King checkout. No systemd service or inbound listener is required. The operator supplies all real endpoints, DIDs, bot names, issuer settings and private configuration. None belong in this repository.

All bots sharing a uid and filesystem form **one trust domain**. Separate names separate mail and signatures, not access to secrets. The shim is a file-backed compatibility adapter, not a vault: `lease` reads a file, and its TTL/client-id flags do not enforce expiry.

## Install and bootstrap

1. Clone the approved commit and install exact dependencies:

   ```sh
   git clone <repository-url> rat-king
   cd rat-king
   git checkout <approved-sha>
   corepack pnpm install --frozen-lockfile
   ```

2. Put an executable `secrets` wrapper on PATH. Use an absolute checkout path:

   ```sh
   #!/bin/sh
   exec node /absolute/checkout/tools/grokbox/secrets.mjs "$@"
   ```

   Set `RATKING_SECRETS_DIR` to a private absolute directory if needed. Default: `~/.local/share/rat-king/secrets`. The shim enforces directory 0700 and key files 0600. It refuses unsafe names, links and add-over-existing. Keep the wrapper and directory outside the checkout.

3. Mint a host identity locally. Take the DID and secret name from the operator:

   ```sh
   node tools/grokbox/mint-host.mjs <host-did> <host-secret-name>
   ```

   Only the public DID document goes to the operator. Never send the secret file, private `d` members or shim lease output. Re-running refuses an existing key.

4. The operator seals the one-time tailnet key to the public document:

   ```sh
   node tools/grokbox/seal.mjs <public-document.json> < <private-key-input-file>
   ```

   On the host, save the received blob outside the checkout, then open it:

   ```sh
   node tools/grokbox/open-sealed.mjs <new-key-file> <host-secret-name> < <sealed-blob.json>
   tailscale up --auth-key=file:<new-key-file> --hostname=<operator-approved-host>
   ```

   For persistent rejoin, write the reusable key to `~/.local/share/rat-king/tailnet.key` and keep it at mode 0600. Delete a one-time key only after the operator confirms it is no longer needed.

   `RATKING_HOST_IDENTITY` may supply the secret name instead of the second argument. There is no host-specific default. The opener authenticates before creating a new 0600 file. It refuses existing paths, wrong-host blobs and tampering. Bootstrap HPKE uses P-256, HKDF-SHA256 and AES-128-GCM, with info `sh.mschf.ratking.grokbox.bootstrap.v1` and `kid` as AAD.

5. Run the single host-owned `tailscaled` process in userspace mode with `--tun=userspace-networking --outbound-http-proxy-listen=127.0.0.1:1055`. The host supervisor owns its lifecycle; do not start a second daemon. Give Node processes both settings:

   ```sh
   export NODE_USE_ENV_PROXY=1
   export HTTP_PROXY=http://127.0.0.1:1055
   export HTTPS_PROXY=http://127.0.0.1:1055
   ```

   Node fetch ignores the proxy environment without `NODE_USE_ENV_PROXY=1`. Use the operator's network setup and verify reachability before provisioning.

6. Receive private `pi.json` from the operator. Set `RATKING_CONFIG` to its absolute path. It supplies `endpoint`, `serviceDid`, `didTemplate`, service `issuer`, and `secretsCommand` pointing at the wrapper. Bot names are never `reserved`. Keep state and documents outside the checkout. The host issuer credential must already be installed through the shim.

7. Provision each bot once through the configured service issuer:

   ```sh
   node tools/grokbox/provision.mjs grokbot/<slug>
   RATKING_NAME=grokbot/<slug> node apps/ratking-cli/bin/ratking.ts whoami --json
   ```

   Provisioning defaults to prefix `grokbot/`; `--prefix <namespace/>` changes that local allowlist. It refuses keys already present and prints only name and DID. The issuer remains the authority; local prefix checking is not an issuer-side security boundary on a shared uid. An issuer failure may leave a generated key locally. Ask the operator to recover registration rather than delete or replace it. `whoami` only attaches existing keys and never provisions.

## Rejoin after a software reset

Run `bash tools/grokbox/ensure.sh` with `TS_VERSION` set to the approved exact static binary version, `TS_HOSTNAME` set to the approved hostname, and `RATKING_SHA` set to the approved full commit. `RATKING_REPO` may identify a checkout elsewhere. There are no fleet-specific defaults.

The script verifies published binary SHA-256 checksums, keeps daemon state under `~/.local/share/tailscale`, reuses a live daemon rather than launching a second one, and joins with the private file key when needed. It keeps the reusable key. It writes proxy exports to `~/.local/share/rat-king/env`, verifies the pinned checkout, installs dependencies once per SHA, and creates the shim wrapper if absent. It exits zero only when the configured mailbox version endpoint returns HTTP 200 through the proxy.

An existing checkout at a different SHA is a refusal, not an automatic reset. A live pid without its socket is also a refusal. After a new daemon starts, rerun if its socket was not ready yet. The script reports the failed step; the host supervisor owns retries and the long-lived daemon.

## MCP

After the MCP app is installed, configure each bot's local stdio server as:

```sh
node apps/ratking-mcp/bin/ratking-mcp.ts --as grokbot/<slug>
```

Supply its private config and proxy environment to the child. One process serves one name. Standard output belongs to MCP only. Normal calls never start a mailbox reader. `ack` takes a short lease and refuses a live holder.

## Wake bridge contract

The separate host-owned wake bridge must:

- Peek only with `inbox --after <throughSeq>` and persist the cursor. Never use `--hold` or acknowledge on behalf of the bot.
- Wake only for mail addressed directly to the bot (`to:`), including asks, from operator-allowlisted senders. CC copies do not wake.
- Limit wakes to six per hour per bot. Retain deferred work rather than discard mail.
- Send the bot webhook only message ids, sender and summary, never keys or bodies.
- Let the bot fetch and handle mail through MCP and acknowledge handled ids.

This kit documents that contract; it does not install a webhook bridge, supervise daemons, change issuer scope or deploy anything.
