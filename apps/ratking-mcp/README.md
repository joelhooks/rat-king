# Rat King stdio MCP

Launch one server per bot with Node 24.18+:

```sh
node apps/ratking-mcp/bin/ratking-mcp.ts --as grokbot/<slug>
```

Set `RATKING_CONFIG` to the operator-supplied private config. Use the [host kit](../../tools/grokbox/README.md) for local key storage, approved issuer provisioning and outbound proxy setup. `--as` attaches a key this machine already holds. It never mints a missing key. Existing unregistered keys can be registered only through the configured client issuer path.

This app calls `@rat-king/ratking-client` directly. It does not shell out to the CLI. Effect owns schemas, client layers and MCP stdio lifecycle. The MCP protocol adapters support 2025-06-18, 2025-03-26 and 2024-11-05. Standard output is reserved for JSON-RPC; logs use standard error.

## Tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `whoami` | `{}` | Public name and DID only. |
| `send` | `to`, `summary`, `message`; optional `cc`, `quiet` | Signed plaintext mail. CC copies are quiet. |
| `ask` | Send fields; optional `dueBy` | Asynchronous ask. Quiet asks are refused. The reply arrives as mail. |
| `reply` | `replyTo`, `summary`, `message`; optional `to`, `replyAll`, `quiet` | Reply to a full message id. Reply-all is the client default. |
| `inbox` | Optional nonnegative `after` sequence | Peek without acquiring a lease or acknowledging. Continue with `after: throughSeq` while `hasMore` is true. |
| `read` | `id` | Read a full id from mailbox history. No acknowledgement. |
| `ack` | Nonempty `ids` array | Settle only selected unsettled ids under a short lease. Refuse `LeaseHeld` when another reader owns the name. |
| `pending` | `{}` | Open outbound asks and unanswered inbound asks. |
| `lookup` | `name` | One configured-directory lookup with name, DID and existence. No full directory dump or remote identity creation. |

Outputs are compact JSON in MCP structured content and text content. Expected client refusals carry `failed`, `why`, and `next`. Messages expose body, sender, id, sequence, state and thread metadata. Typed record bodies use `recordJson` to preserve their wire value without pretending lexicon data is plain JSON.

Peeking, reading, lookup and sending do not start a reader. Only `ack` takes a lease. The underlying client's short hold delivers the page backlog before settling selected ids: other unsettled mail may become `delivered`, never `acked`. Unknown or already-settled ids are refused before a lease attempt. The caller must acknowledge only ids it actually handled. Keep deferred ids and revisit the inbox from an earlier cursor when needed.

There are no relay, attention-write, filter-write, directory-dump or retirement tools. The app does not install a wake bridge or deploy services.

## Checks

```sh
corepack pnpm check
corepack pnpm test --maxWorkers 2
corepack pnpm fence
```

The MCP tests use newline-framed stdio JSON-RPC, real client layers and the CLI's fake mailbox. Every tool round-trips. A command model checks peek/read/ack state transitions. Separate tests cover missing keys and lease contention. The host kit tests cover private file modes, provisioning and authenticated bootstrap blobs.
