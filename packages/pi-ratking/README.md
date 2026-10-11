# @rat-king/pi-ratking

A Pi extension that gives any Pi a Rat King name and messaging. It has no Muster dependency. Load it with `pi -e packages/pi-ratking/src/extension.ts`, or install the package; its `pi` manifest names the extension.

## Configuration

The extension reads `RATKING_CONFIG`, or `~/.config/rat-king/pi.json`. Without a valid file, every action fails with `NOT DELIVERED: NotConfigured` and the reader stays off. Example with invented values:

```json
{
  "endpoint": "https://mailbox.example.invalid",
  "serviceDid": "did:web:mailbox.example.invalid",
  "didTemplate": "did:web:{agent}.pi.example.invalid",
  "documents": ["/path/to/public-documents.json"],
  "issuer": { "command": ["sh", "/path/to/mailbox-cli-wrapper.sh"] },
  "reserved": {
    "switchboard": { "did": "did:web:switchboard.example.invalid" },
    "fleet-owner": {
      "did": "did:web:fleet-owner.example.invalid",
      "aliases": ["servo"]
    }
  },
  "refuse": ["fleet-owner"],
  "toolName": "ratking"
}
```

`state` defaults to `~/.local/state/rat-king/pi`. It holds the name claims, read cursors, locks and `directory.json`, the name → DID and public document directory. `documents` lists files of public DID documents, such as the operator-configured fleet documents. `askTimeoutMs` defaults to ten minutes. A name in `refuse` starts no reader and mints nothing: `status` reports it as refused and every send fails with `NOT DELIVERED: Refused`. Use it for names another reader still holds.

## Names

`RATKING_NAME`, set by the launcher, wins. Muster sets `<project>/<row>`. Aliases in `reserved` map to their reserved name. Without it, the Pi names itself from its Herdr pane label slug, else `pi-<session id>`. A derived name is never reserved, never another live session's claim and never an existing directory name. Claims are written under a lock.

## Identity and issuer

Keys are P-256 pairs generated on the Pi's host. They are stored in the host secret store (agent-secrets) as `rat_king_fleet_agent_<label>_identity`, passed to `secrets add` on stdin, never in argv or logs. `<label>` is the name with `/` replaced by `.`. Existing secrets are reused and never rotated; their DID wins over the template. Reserved names are never minted; their secret must already exist on the host to read or send as that name. A reserved recipient needs no local secret. Its public document comes from the configured `documents`, the local directory, or a mailbox `getPeerDocument` lookup when neither has it. Aliases resolve to the canonical reserved name and DID.

Registration goes through one service, `Issuer.ensure(name, publicDocument) → did`. `issuer` takes one of two shapes.

`{ "endpoint": "https://mailbox.example.invalid", "host": "<host identity secret>" }` is the service issuer. It leases the host's identity JSON from the host secret store and calls the mailbox's `identity.register` with a service-auth JWT signed by the host key. The operator must first enroll that host (`mailbox enroll-host`). The issuer derives the DID from the name with its own template, so `didTemplate` must match the server's. A refusal (`NameTaken`, `NameReserved`, `Forbidden`) fails provisioning with that code. With this issuer, `list` also pages the issuer's directory and records names that are not yet local, so their documents resolve for sending. Local entries are never replaced.

`{ "command": [...] }` is the command issuer. It writes the public document to a private temporary file, runs `<command> register --did <did> --document <file>` and records the name in the directory. Point it at a mailbox CLI built from this repository; bundles without `register` refuse. The operator key stays with that CLI. A later issuer can replace the layer without changing callers.

## Reader

On `session_start` the extension claims its name, ensures its identity and runs `@rat-king/mailbox-client`'s leased consumer for its DID. Failures retry with exponential backoff capped at 30 seconds and show in `status`; they are never fatal. On `session_shutdown` the runtime is disposed, which releases the lease, so a successor Pi acquires it at once.

Each inbound message is injected as a visible `ratking_message` with sender, body, id and a reply hint naming this tool, except program-to-program data and lexicon records. The transcript renderer defaults to one line with the sender label or name, first body line and message id. CC, reply and unverified markers remain visible. Pi's expand toggle (`ctrl+o`) shows the full message and reply hint. Rendering uses message details; model-facing content is unchanged. The handler checkpoints the event's `seq` before ack, so a restarted reader does not replay acked mail. While the reader holds its lease, sends carry the lease fence, as the mailbox requires.

The payload is `{ from, body, kind?, replyTo?, summary?, label?, to?, cc?, thread? }`. It carries no session id: whoever holds the name's lease reads its mail. A sender name is verified when the directory maps the signed sender DID to it, or when the claimed name derives that DID through the template or reserved table.

A reader with no cursor starts at the mailbox's current head (`throughSeq`), so an identity with history never replays it. A message the server refuses to deliver or ack with `InvalidTransition` (already acked, expired or otherwise settled) is skipped and the cursor moves past it.

A message that cannot be opened (unknown sender, bad signature, undecryptable or malformed envelope) triggers one lookup of the sender's document through the mailbox's `getPeerDocument`, then one more open. If that fails, the reader writes `state/quarantine/<label>/<seq>.json` with metadata only (`seq`, `messageId`, `senderDid`, `reason`, `at`; never the body or ciphertext), skips the message without deliver or ack, and moves the cursor past it. `status` shows the quarantine count and the latest entry.

A decrypted JSON object with a string `$type` that is not a Rat King message payload is delivered on `ratking/record` only, never injected into the model, except a verified desk relay received by its configured EA. Records use the same sender verification, checkpoint and ack path as messages. Other decrypted bodies still follow the raw-text message path.

## Staff relay

Opt in at reader start with this `pi.json` field:

```json
"relay": { "name": "switchboard", "to": "switchboard/ea", "mode": "copy", "fallbackMinutes": 10 }
```

Set the same `relay` field on the desk and EA. Only the reader whose own name equals `relay.name` forwards mail; `relay.to` accepts verified desk relays for model delivery. Other names ignore this config. The desk keeps its identity and key. Staff has its own identity. `copy` injects each text message normally and forwards it asynchronously. A verified message from `relay.to` bypasses forwarding. Data and other lexicon records keep their existing event-only paths.

The forwarded signed record is `{ $type: "sh.mschf.ratking.relay#message", id, from, did, verified, kind, body, replyTo, summary, label, cc, encrypted, ccNames?, to?, thread? }`. Nullable text fields use `null` when absent. `id` is the original message id, not the relay envelope id. The original encryption state controls the relay envelope: plaintext stays plaintext; encrypted stays encrypted. Forwarding uses the same sealed-envelope bounded retry as ordinary sends. Failure logs without dropping the original.

`front` saves originals in `state/relay/<name-label>.json` before mailbox ack and suppresses their injection. Verified staff confirms with `{ $type: "sh.mschf.ratking.relay#handled", id: "<original id>" }`, sent as a record to the desk. A failed forward or expired deadline injects the original with `[staff did not handle]`, even if it previously settled an ask waiter; a restarted Pi no longer has that waiter. A one-second sweep handles deadlines; startup recovers overdue pending mail before consumption. Only a verified staff envelope can settle pending mail. Journal files and their directory are private (0600/0700). Malformed journals fail closed and retry, never reset themselves.

### EA integration

The EA needs only pi-ratking, not a `ratking/record` consumer. When its own name is `relay.to`, the reader accepts a relay record only from a verified `relay.name`. It projects the original sender, label, verification flag, id, summary and body, remembers that original for replies, and injects a visible turn-starting message. The compact view adds `via switchboard`. The original verification flag is the desk's attestation, not a second original-sender signature. Wrong senders and other records stay on the record-event path and never become model mail.

The reply hint uses the original id and `replyAll: false`, so the EA answers the original sender directly. `reply` links that original id, preserves the thread root, and defaults to the original encryption state. In front mode a successful reply also sends a `sh.mschf.ratking.relay#handled` record to the desk. If the reply was accepted but that confirmation fails, the tool reports partial delivery and tells the EA to retry only `handled`, not the answer.

For work handled without a reply, call `intercom({ action: "handled", replyTo: "<original id>" })` (or the configured tool name). It sends the handled record to the verified desk DID stored with the original, using the original encryption state. It refuses unknown ids, ordinary mail and a changed desk DID. The explicit handled action is also available in copy mode; automatic confirmations run only in front mode. A direct EA reply does not settle an `ask` that names the desk's DID: it arrives as normal mail from the EA. The strict asked-DID waiter rule is unchanged.

Custom producers can still emit `ratking/send` with `{ requestId, to: record.from, body: answer, replyTo: record.id, replyToDid: record.did, thread: record.thread ?? record.id, encrypt: record.encrypted, summary }`. `replyToDid` selects a direct reply-link path without local thread lookup. Ordinary EA replies do not need this bridge.

The routing model covers generated inbound, handled, failed-forward, clock and restart commands. The EA model covers verified-desk admission, wrong sender/receiver rejection, original-field projection, direct reply hints and compact via markers; removing model delivery falsifies it. The recipient-view test also checks a turn-starting EA message, an encrypted original-id reply to the sender, and its automatic handled record. Removing startup recovery falsifies the property on an overdue original. Completed-command restarts are covered. An abrupt crash between Pi injection and its journal checkpoint can replay that injection: Pi has no transactional/idempotent injection port. Terminal journal entries remain to deduplicate recovered originals; journal compaction is not implemented. The accepted policy is at-least-once across abrupt crashes and exactly-once after completed operations: replay is preferable to losing mail. `front` remains a later desk-controlled config change. To disable front routing safely, switch to copy while pending originals recover, then remove the config only after the pending set is empty. Removing the config or reverting the reader before draining pending mail would strand already-acked originals.

## Tool

The tool takes pi-intercom's parameters. `send`, `ask`, `reply`, `handled`, `pending`, `list` and `status` work. `ask` waits for the reply whose `replyTo` names the ask and whose signed sender is the asked DID; other messages are injected normally. `handover`, `cancel`, `cwd` targeting and `openProjectPaneIfMissing` are refused with a clear error. A send the mailbox did not take returns `NOT DELIVERED: <code>`, with no fallback.

Pi keeps the first tool registered under a name and silently drops later ones. While pi-intercom is loaded, keep the default name `ratking`. After pi-intercom is removed, set `"toolName": "intercom"` or `RATKING_TOOL=intercom`.

## CC and threads

`send` and `ask` accept `cc: ["name", ...]`. The reader resolves all recipients before sending, canonicalizes names, deduplicates names and DIDs, and removes itself from cc. Each recipient gets its own signed envelope containing the identical payload: `to` names the primary recipient, `cc` lists the additional recipients, and `thread` is the first envelope's id for a new conversation. Envelope ids differ; the shared thread root does not. No server, lexicon or signature format changes are involved. Old message decoders drop the new payload fields.

`ask` waits only for the primary recipient's reply; cc recipients do not settle its waiter. `reply` defaults to reply-all: the received message's sender, `to` and `cc`, minus this reader. `replyAll: false` answers only its sender. The reader stores participant fields and the root in `threads.ts`, including replies that settled an ask. Replies preserve the root and link the specific received envelope with `replyTo`. Older messages without participant fields remain sender-only. The compact header renders `cc: a, b` inside the existing four-line budget; long headers are clipped to the terminal width.

Each envelope retains the existing bounded retry with its own id. If admission fails after another recipient accepted, the tool reports `PARTIAL DELIVERY` with accepted names and ids; it does not pretend nothing was delivered. Unknown recipients fail before any envelope is submitted. A successful result returns the primary receipt. This is not an atomic group send. Thread records remain limited to 200 received messages in this Pi runtime; they are not persisted across restarts.

The reply-all model uses generated thread records and reply policies. Removing self-exclusion falsifies it, including sender-only replies to yourself. The transport property opens both envelopes, verifies identical bodies and the primary-id root, checks encryption and recipient deduplication, and proves unknown-cc preflight sends nothing.

## Events for other extensions

- Emit `ratking/send` with `{ requestId, to, body, kind?, encrypt?, cc? }`, or `{ requestId, replyTo, body, kind?, encrypt?, replyAll? }` to answer a received message. Replace `body` with `record: { $type: string, ... }` to send a JSON lexicon record. Exactly one of `body` or `record` is required. Records are sealed as-is, without the message wrapper, and default to encrypted; `encrypt` overrides encryption per send. Message bodies keep the configured encryption default. `kind` is `message`, `ask` or `data`; `data` is for program-to-program traffic: the recipient gets it on `ratking/message` only, never in the model's context. Records carry their own fields; `kind` adds no wrapper or record field. `replyTo` links the envelope to a received message or record. A trusted relay integration can also supply `to`, `replyToDid` and `replyTo` to send directly to the original sender without a local thread lookup; `replyToDid` without `replyTo` is refused. Optional `thread` preserves the relay's root; `summary` supplies the message summary. A malformed request that still has a `requestId` is answered at once with `not-delivered`. The extension emits `ratking/send:result` with `{ requestId, status: "delivered", id, seq, to }` or `{ requestId, status: "not-delivered", code, reason }`.
- `ratking/record` carries inbound lexicon records: `{ id, from, did, verified, record, replyTo? }`. It never settles a waiting text ask. A verified relay addressed to the configured EA instead takes the original-message path, with model injection; it is not emitted as a raw record event. A valid Rat King message payload takes the message path even if it also has a `$type`.
- Emit `ratking/status` with `{ requestId }`. `ratking/status:result` answers with `{ requestId, name, did, reader, leaseGeneration?, leaseUntil? }`. `reader` is `live`, `acquiring`, `retired`, `off` or `send-only`. Live readers include their lease generation and expiry. `name` and `did` are null when no identity is available, including after retirement. Provisioning, retries and refusals report `off`; lease acquisition reports `acquiring`.
- `ratking/message` carries every inbound message: `{ id, from, did, verified, body, kind, replyTo, cc, ccNames?, to?, thread?, settled }`. `cc` remains the legacy boolean marker; `ccNames` carries the signed participant list. `settled` is true when the message answered a waiting ask.
- Emit `ratking/retire` with `{ requestId? }` when another session has taken over this Pi's name, for example once a restart handover commits. The reader stops and releases its lease while the Pi stays up, so a lingering old process can't ack mail its successor should read. The extension answers on `ratking/retire:result` with `{ requestId?, status: "retired" }`. Later sends are refused as retired until the next session start. Shutdown also waits up to 2 s for the lease release.

`ratkingExtension({ layer, facts, tool })` builds the extension against a `PiHost` port (events, tool and message registration, session start and end). The default export adapts Pi's `ExtensionAPI` to that port with the production layer; tests drive the same factory with Pi's `createEventBus` and a fake mailbox.

## Limits

- A host without an issuer can use only names with existing secrets and directory entries.
- The issuer directory lists only names registered through it. Names registered with the command issuer are invisible to it.
- A reader that loses its cursor resumes at the head; mail that arrived while it had none is skipped, not read.
- A quarantined message stays unacked on the server; its sender sees no delivery.
- Registered DID documents have no revoke route.
