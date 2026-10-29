# Mailbox restore drill

`restore-drill` is an opt-in, local Linux nest action. It never calls the production restore, deploy or listener lifecycle. Run it on the mailbox host, from the source checkout, with Node 24+, Python 3.12+, systemd and permission to create a system transient service through `sudo -n`.

## Configuration

Add `restoreDrill` beside `runtime` in the private fleet stage file. Example values are invented:

```json
{
  "restoreDrill": {
    "bucket": "example-mailbox-cells",
    "celld": "/opt/example/bin/celld",
    "knownDid": "did:web:desk.example.invalid",
    "knownName": "example/desk",
    "messageDid": "did:web:reader.example.invalid",
    "node": "/usr/local/bin/node",
    "receipts": "/srv/example-state/restore-drill.jsonl",
    "scratchParent": "/srv/example-scratch",
    "weed": "/opt/example/bin/weed"
  }
}
```

`knownName` must be an ordinary name the issuer lists in both the live service and the backup, with `knownDid` taken from the live issuer. A host's reserved names, such as the switchboard, live only in that host's local table and never in the issuer, so they can't serve as proof names. A name missing from the restored issuer fails with `PROOF_NAME_NOT_IN_ISSUER`.

The scratch parent and receipt parent must already exist. The scratch parent cannot overlap the backup share or any production data root declared in `runtime.RATS_NEST_INSTANCE`. The receipt cannot live inside those protected roots. Keep instance configuration, receipts and actual host paths outside the public repository.

Run:

```sh
RAT_KING_STAGE_CONFIG=/srv/example-state/fleet.json node stacks/nest/cli.ts restore-drill
```

The action requires fleet stage and explicit drill settings. Missing settings leave it unavailable. It uses the existing `runtime.RAT_KING_BACKUP_ROOT` and reads that share only. It refuses a running backup or the 10:00–10:14Z backup window.

## Proofs

1. Select the newest dated directory with a published manifest. Never fall back to an older publication when the newest is incomplete or corrupt. This drill accepts format 4 only.
2. Check free disk space against archive bytes plus extracted bytes, with 20% headroom and another GiB. Copy while checking SHA-256 and byte length. Stream-extract only regular files/directories under `celld` and `seaweedfs`; refuse links, traversal, duplicates and inventory overruns. Compare both archive and actual extracted inventories exactly with the manifest.
3. Start fresh child processes in a unique `restore-drill-<random>.service`, with `PrivateNetwork=yes`, `PrivateTmp=yes`, a runtime deadline and control-group teardown. Allocate ten ephemeral ports inside the isolated loopback namespace. Generate scratch S3 credentials. Derive `-volume.max` from the live SeaweedFS unit's effective argv, read-only; refuse an unreadable, missing, automatic or ambiguous value. Before starting services, count unique restored `.dat`/`.idx` volume slots and require that count plus 16 to fit under the live maximum. Refuse with `restore needs N volume slots, max M` otherwise. Keep the 64-MB master size limit and loopback binding. Wait for both filer and S3 readiness before starting celld. Never load production environment files or signing keys.
4. Read the restored application's version and health. Inspect cached SQLite schemas and celld's `_cf_METADATA.actor_name` read-only before any mailbox activation; do not require application metadata that a cold actor has not reconstructed yet. Close every SQLite handle explicitly rather than relying on its transaction context manager or garbage collection. Select exactly two distinct configured DIDs: `messageDid` (the message actor) and `knownDid` (the desk actor). Activate only those scopes, one at a time, inspect their current SQLite epochs read-only, and evict each afterward. Derive the newest message in the configured message actor and the two selected actors' message/event counts. Missing or ambiguous selected identities fail closed; unrelated cached scopes never activate. Validate the selected actors' application schemas and recipient identities after activation.
5. Temporarily add an in-memory ephemeral signer's public key to the copied deployment's public authorization bindings. Keep the restored application code unchanged. Read the selected actor's newest message envelope through `mailbox.list`; paginate only the two selected mailboxes and compare event/message totals with zero tolerance. Resolve the configured name through the restored directory, falling back to the restored issuer template for legacy names. Activate its mailbox through `resolveLease`, then prove its saved lease record read-only. An expired lease is valid backup evidence; the drill never renews it. Restore the copied authorization bindings in `finally`. Evict both selected scopes after the API phase and retain deactivation outcomes in the private receipt.
6. Before stopping owned children, capture at most the last 200 lines or 64 KiB of each stdout/stderr stream, whichever is smaller. Keep fixed diagnostic classes, suppressing free-form output. Weed classes include no-free/writable-volume, assignment, growth, read-only and disk events. Timeout lines alone may also retain endpoint authorities (no URL userinfo, path or query), bucket names, allowlisted operation names and error kinds. These explicitly permitted endpoint/bucket fields are private diagnostic metadata, not public publication output. Lines containing body or credential-value fields suppress target extraction. Check fixed classes with the publication fence. Record exact argv and environment variable names, never values. Copy these diagnostics into the mode-0600 receipt before deleting scratch; even failed startup diagnostics survive root removal. A diagnostic-retention failure never replaces an already propagating proof failure; the parent can recover tails after the worker releases its resources. If retention is the only failure, it remains fatal. The proof driver's promise finalizer likewise preserves its first failure if restoring the auth fixture also fails. It records an allowlisted `step` before work and advances `lastOk` only after success. Failure records snapshot both before cleanup changes the progress state. They preserve Effect Fail, Die and Interrupt causes through `runPromiseExit`, fixed assertion codes, allowlisted `_tag` values, HTTP status and known XRPC error codes, including Rejected outcomes. They never classify by message text or retain arbitrary reasons. Final eviction records retain a fixed outcome code and HTTP status when available, alongside the existing required boolean. The parent copies the final progress and failure records before root deletion; logging safe metadata precedes file writes so file-write failure cannot suppress the journal attempt. No requests, tokens, bodies or free-form errors are dumped. Stop owned children, prove the unique unit and cgroup have gone, then delete only the root whose marker, device and inode match this run. A cleanup failure keeps the run failed and retains the root for inspection. Append and fsync one private JSONL receipt. A missing proof or teardown field cannot pass the typed receipt contract.

Format 4 does **not** contain logical mailbox row counts. The manifest proof is the exact filesystem inventory. Logical counts use the restored SQLite data as their baseline and the scratch HTTP API as their readback. These are separate claims, not invented manifest fields.

### Exact count definition

`mailbox.list` is a sequence-bounded event replay, not a list of currently unread messages. It authorizes one recipient and returns every event with `afterSeq < seq <= throughSeq`, in ascending sequence order. The drill starts at sequence zero and follows the snapshot cursor through every page. There is no expiry, acknowledgment/consumption, tombstone, retired-name or age/retention-window filter in this query. Retirement and delivery state do not remove historical admissions from this replay.

The inventory counts **all rows in `events`** and **all rows in `messages`**, not just delivered/unacked state. It also reads each stored message's exact `(recipient, sender, messageId)` key: the verified SQLite recipient plus the stored `sender` and `tid` columns. Those keys stay in the private scratch inventory and process memory, never in failure metadata or the final key-proof summary.

The API side counts every returned event. For recognized `MessageEvent` values, it builds a **distinct set of `(receipt.recipientDid, receipt.message.senderDid, receipt.message.messageId)` keys**. Repeated admissions remain separate events but add no new message key. Later receipt/attention events do not add message keys. Delegated copies use their receipt's copy identity, not the envelope's original message identity, including for the newest-message readback.

The proof requires **both set differences to be zero**: every event key must have a stored row, and every stored row must have an event key. Equal totals alone are not proof. A missing stored row fails first with `EVENT_KEYS_WITHOUT_STATE`; a stored row without a replayed admission fails with `STATE_KEYS_WITHOUT_EVENT`. Both retain only the numeric difference and inventory position. After key equality, total replayed events must equal the SQLite event inventory and distinct message keys must equal stored message rows, with **zero tolerance**. Invalid sequences, missing admissions, wrong recipients and same-cardinality substitutions remain failures. Numeric `mailboxKeyProofs` report both zero differences and admission/repeat counts separately; keys and message contents are not included.

Current admissions append an event and insert a message row transactionally, and current duplicate-send paths return an existing admission. Historical repeated admissions cannot be assumed absent. This drill does not change mailbox write behavior or label the cause of historical repeats. The event protocol can replay unknown union tags; the proof recognizes messages with the full `MessageEvent` schema guard, not by delivery state. Valid event sequences are positive, so a complete replay from zero covers the raw event inventory.

The last failed live run established only that the event total matched and the message total did not. Its numeric comparison values were not retained. That does **not** identify data loss, a torn snapshot or a different actor. The backup source requires both writers stopped before its snapshot copy; this argues against an ordinary concurrent-write snapshot but is not a retrospective proof of every stored row. Actor identity checks and matching event totals likewise do not prove identical contents. The distinct-key projection corrects the comparison's meaning; it does not permit a missing row or claim a live qualification.

Count failures retain `assertionCode`, numeric `expected` (SQLite baseline), `actual` (API replay) and zero-based `mailboxIndex` (inventory position, never a DID), alongside the failure step and last successful step. Numeric fields are nonnegative safe integers and are projected only for assertion faults. New diagnostics cannot reconstruct values lost by an older run. A further live attempt needs separate approval.

## Qualification and follow-ups

Properties cover publication selection, checksum/extraction round trips, marker/inode teardown refusal, symlink containment, required proof gates, failed-run receipts, diagnostic redaction/bounds and diagnostic survival after root deletion. Full scratch-service/API qualification still needs a successful live run. A cancelled attempt and a later scratch-service startup failure produced complete teardown proofs, not passing restore proofs. Structured-cause properties exercise real Effect failures, defects, interruptions and Rejected send outcomes without sending anything. Offline branch mutants must fail those fault contracts. These diagnostics do not qualify the live API path or authorize another attempt.

Do not schedule this action until that live proof passes. A separate approved step can install a weekly timer outside the nightly backup window, run it through the fleet heavy-work lock, and have the health digest consume the configured JSONL's latest receipt and age. No timer, persistent unit or digest reader is installed by this packet.
