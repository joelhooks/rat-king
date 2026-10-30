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

   On the host, save the received blob outside the checkout. Open it into a new file in the 0700 runtime dir, then join with that file:

   ```sh
   run=${XDG_RUNTIME_DIR:-/tmp}/tailscale-$(id -u)
   node tools/grokbox/open-sealed.mjs "$run/join.key" <host-secret-name> < <sealed-blob.json>
   bash tools/grokbox/ensure.sh --join "$run/join.key"
   ```

   `ensure.sh --join` uses the key once with `tailscale up --auth-key=file:<f>` and deletes the file right after, whether the join succeeded or failed. No key is stored for later. Every bot on the host shares one uid, so a stored key would let any of them add nodes.

   `RATKING_HOST_IDENTITY` may supply the secret name instead of the second argument. There is no host-specific default. The opener takes an explicit new path only. It authenticates before creating a new 0600 file, and refuses existing paths, wrong-host blobs and tampering. Bootstrap HPKE uses P-256, HKDF-SHA256 and AES-128-GCM, with info `sh.mschf.ratking.grokbox.bootstrap.v1` and `kid` as AAD.

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

The script verifies published binary SHA-256 checksums, keeps node state under `~/.local/share/tailscale` (0700), reuses a live daemon rather than launching a second one, and restarts the daemon from that state. The node comes back without a key. It never reads a stored key. If the state is missing or the node is logged out, it exits nonzero with `ensure: node state lost; ask the desk for a fresh one-time key sealed to the host key`, and never tries a key on its own. Then open the new key as in step 4 and run `ensure.sh --join <file>`. It writes proxy exports to `~/.local/share/rat-king/env`, verifies the pinned checkout, installs dependencies once per SHA, and creates the shim wrapper if absent. It exits zero only when the configured mailbox version endpoint returns HTTP 200 through the proxy.

An existing checkout at a different SHA is a refusal, not an automatic reset. Runtime files live in `${XDG_RUNTIME_DIR:-/tmp}/tailscale-<uid>`, not the persistent state directory. The script checks the recorded process command line and scans for a daemon using the socket before removing stale runtime files. It refuses a live unresponsive daemon. A new daemon gets up to 30 seconds to answer status before join. The script reports the failed step; the host supervisor owns later retries and the long-lived daemon.

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
