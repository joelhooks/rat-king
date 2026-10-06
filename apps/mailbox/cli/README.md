# Mailbox CLI

The CLI and network consumers use `@rat-king/mailbox-client`. Build one Node module with pinned esbuild:

```sh
RAT_KING_CLI_OUTPUT=/tmp/mailbox.mjs node apps/mailbox/cli/build.ts
node /tmp/mailbox.mjs --help
```

Supply the public documents file, endpoint and service DID through `RAT_KING_DOCUMENTS`, `RAT_KING_ENDPOINT` and `RAT_KING_SERVICE_DID`. Inventory stays outside the repository. Each HTTP call mints a fresh, method-bound, 60-second ES256 service-auth JWT. The audience is the service DID plus `#mailbox`.

## Provision an agent

`register --did <did> --document <public-json>` registers an externally held identity without minting or exporting its keys. It refuses private material anywhere in the document and requires its id to match `--did`. It uses the existing operator configuration and the idempotent `putDidDocument` route.

`provision` keeps both P-256 private keys in `agent-secrets`. `RAT_KING_OPERATOR_IDENTITY` names an identity JSON secret authorized by the server's `OPERATOR_DIDS` binding. The command leases it to register the agent's public DID document.

```sh
node /tmp/mailbox.mjs provision --agent example --did did:web:example.invalid
node /tmp/mailbox.mjs provision --agent example --did did:web:example.invalid --secret example_identity
```

The default secret name is `rat_king_agent_<agent>_identity`. Agent names start with a lowercase letter and contain lowercase letters, digits, underscores or hyphens, up to 63 characters. Explicit secret names contain letters, digits, underscores or hyphens and start with a letter or digit, up to 128 characters. `agent-secrets` itself requires a nonempty name; these narrower rules keep our labels safe for CLI use.

Existing secrets are reused, never rotated. A different DID stops the command without replacing either key. New identity JSON goes only to `secrets add <name>` on stdin. The command prints only `{ did, secret, document }`, with public JWKs. An identical registered document succeeds; a different document returns `DocumentConflict` and exits nonzero. If registration fails after local keys were stored, the keys remain for a safe retry.

`--secrets-config` and `--secrets-socket` select an isolated `agent-secrets` store and daemon for testing. They apply to operator and agent leases and additions alike. Private identity values never appear in argv, repository files, process output or failure diagnostics.

## File identities for existing proofs

```sh
node /tmp/mailbox.mjs identity --as example --did did:web:example.invalid
```

`identity` creates the two keys once in `~/.config/rat-king/agents/<agent>.jwk`, with mode 600. It prints only the public document. A different DID or unsafe permissions stops the command. This file custody remains a proof-only shortcut. Provisioning does not use it. The existing `--from` and `--as` flags select these file identities.

## Messages

```sh
node /tmp/mailbox.mjs send --from example --to did:web:recipient.invalid --body 'proof message' --urgent
node /tmp/mailbox.mjs send --from example --to did:web:recipient.invalid --record packages/lexicon/test/fixtures/desk-item.json
node /tmp/mailbox.mjs list --as example --after-seq 0 --limit 50
node /tmp/mailbox.mjs list --as example --cursor '<cursor from previous page>'
node /tmp/mailbox.mjs open --as example --file /tmp/envelope.json
```

`send` requires exactly one of `--body` or `--record`. The record path reads a JSON desk item, answer or update, validates its generated codec and seals that JSON as the envelope body. Shared fixtures contain invented data; private cards stay outside this repository. The standalone record-input suite runs with `pnpm exec vitest run --config apps/mailbox/cli/vitest.config.ts`.

`send` can take `--lease-id` and `--generation` together when the sender holds a lease. `--urgent` is signed inside the encrypted payload. `list` prints the generated wire format, including byte wrappers. Follow every cursor with the other parameters unchanged, then checkpoint `throughSeq`. Save a message event's `envelope` field for `open`. `open` decrypts, verifies the application signature and bound metadata, then prints sender DID, TID, body, optional reply and urgent fields, and `verified: true`. Failed verification never prints a verified body.

## Lease and delivery

```sh
node /tmp/mailbox.mjs lease acquire --as example --session-id '<harness session>' --expires-at '<future RFC3339 timestamp>'
node /tmp/mailbox.mjs lease renew --as example --lease-id '<leaseId>' --generation 1 --expires-at '<future RFC3339 timestamp>'
node /tmp/mailbox.mjs lease resolve --as example --did did:web:example.invalid
node /tmp/mailbox.mjs deliver --as example --sender did:web:sender.invalid --tid '<message TID>' --lease-id '<leaseId>' --generation 1
node /tmp/mailbox.mjs ack --as example --sender did:web:sender.invalid --tid '<message TID>' --lease-id '<leaseId>' --generation 1
node /tmp/mailbox.mjs lease release --as example --lease-id '<leaseId>' --generation 1
```

Use the lease ID and generation returned by acquire, not fixed values. Acquire refuses an unexpired holder, including the same caller. The server clamps expiry to five minutes. Renew, release, deliver and ack require the current fence. Deliver records runtime dispatch; ack records completion after the turn. Neither polling nor watching performs either operation.

## Network package

`layer(config)` requires only Effect 4.0.1's `HttpClient.HttpClient`, normally supplied by `FetchHttpClient.layer` from `effect/http`. `RatKingMailbox` exposes send, list, poll, watch, open, deliver, ack, lease and DID registration. `poll` gathers every page of one snapshot. `watch(afterSeq, fence)` sends auth as the first WebSocket frame and waits for the first notice as the authentication-ready barrier before listing. It catches up on every later notice and emits nonempty batches. Tokens never enter the URL. Consumers checkpoint a batch only after processing it.

Transport drops reconnect with jittered exponential backoff capped at five seconds. Server close codes 4409 (stale lease) and 4401 (auth failure) stop the stream even before readiness. Code 4408 (first-frame timeout) is transient and retries, as do normal and abnormal transport closes. Reacquire authority and start a new watcher from the consumer's last checkpoint. Interruption closes the owned socket. `WebSocketPort` permits tests to replace Node 24's global WebSocket.

Crypto remains **unreviewed**. No deployment or production-readiness claim is made by this packet.
