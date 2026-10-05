# Mailbox proof CLI

Build one ES2022 Node module with the pinned esbuild:

```sh
RAT_KING_CLI_OUTPUT=/tmp/mailbox.mjs node apps/mailbox/cli/build.ts
node /tmp/mailbox.mjs --help
```

`identity` creates two P-256 private keys once, in `~/.config/rat-king/agents/<agent>.jwk` with mode 600. It prints only the public DID document. Running it again preserves both keys. A different DID or unsafe file permissions stops the command.

```sh
node /tmp/mailbox.mjs identity --as example --did did:web:example.invalid
```

This file-based custody is a **proof-only shortcut**. The intended contract is operator-vault custody with runtime leases. Never place private keys in the repository, Alchemy state, Worker variables or public DID documents. Provision each identity on its own machine. Deploy only its public document.

Supply the public documents file, Worker endpoint and service audience through `RAT_KING_DOCUMENTS`, `RAT_KING_ENDPOINT` and `RAT_KING_SERVICE_DID`. Inventory and these values stay outside the repository.

```sh
node /tmp/mailbox.mjs send --from example --to did:web:recipient.invalid --body 'proof message'
node /tmp/mailbox.mjs list --as example
node /tmp/mailbox.mjs list --as example --cursor '<cursor from previous page>'
node /tmp/mailbox.mjs open --as example --file /tmp/envelope.json
```

`list` prints the generated Lexicon wire format, including byte wrappers. Save a message event's `envelope` field as the input to `open`. Follow each returned cursor until it is absent. `open` decrypts, verifies the ES256 application signature and checks the bound metadata before printing sender DID, TID, body and `verified: true`. Failed verification never prints a verified body. Every HTTP call mints a fresh, method-bound, 60-second service-auth JWT.

## Proof-only lease seam

`POST /rat-king/v0/lease` is not an XRPC method or a published Lexicon. Its service-auth JWT binds `lxm` to that exact path. The verified issuer selects its own mailbox; callers cannot name another recipient. It acquires or renews that recipient's existing DO lease. An optional message reference records runtime delivery through the existing lease authority, so the normal XRPC ack can move the message from delivered to acked.

After opening and verifying a received envelope:

```sh
node /tmp/mailbox.mjs lease --as example --sender did:web:sender.invalid --tid '<message TID>'
node /tmp/mailbox.mjs ack --as example --sender did:web:sender.invalid --tid '<message TID>' --lease-id '<leaseId from lease>' --generation 1
```

Use the generation returned by `lease`, not a fixed generation. The lease lasts 60 seconds. To renew it, pass `--lease-id` and `--generation` to `lease` without `--sender` or `--tid`. Record delivery once before acking. The service audience is the configured service DID plus `#mailbox`.

The envelope implementation is unreviewed. This CLI is for the controlled proof, not a claim of cryptographic production readiness.
