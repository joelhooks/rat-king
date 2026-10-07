# @rat-king/mailbox-client 1.0.0

A library in the caller's process, not a daemon. Muster should pin `ownIdentity`, `prepare`, `SendOutcomes`, and the `OwnIdentity`, `PeerDocument`, `SendOutcome`, `SendResult`, `ConsumeOptions` types from the package root. Existing `RatKingMailbox`, `layer`, `WebSocketPort` and crypto exports remain available.

## Prepare and send

Import an existing private identity with `yield* ownIdentity(identity)`. It returns an opaque process-local handle. It never generates keys. Call `yield* prepare({ own, peers, endpoint, serviceDid })` inside an Effect scope with `HttpClient.HttpClient`. Peers are public DID key documents, not local identities. The caller owns trusted bootstrap documents, aliases, session binding, activation permission and durable intake policy.

`yield* client.refresh(did)` queries the authenticated public directory. The authority allows only configured-document DIDs, operator DIDs and observer DIDs. Both caller and requested DID must belong to that set. Registration alone does not grant directory access. Only public keys are returned, without service endpoints. A changed document fails closed and retains the previously trusted keys. New peers require successful directory lookup or explicit caller-provided documents. Unknown peers never trigger key creation or arbitrary document trust.

Seal once: `const envelope = yield* client.seal(recipientDid, body, options)`. Then call `yield* client.send(envelope, { fence, cc })`. The optional sender fence carries the current leaseId and generation.

- `NotAttempted`: local validation or peer resolution refused the operation before submission.
- `Rejected`: a confirmed 4xx response refused submission.
- `Accepted`: the original durable admission receipt.
- `Uncertain`: transport, response decoding or server availability did not confirm admission. Retry the **same sealed envelope**, never seal again. Persist it in the caller's outbox if retries must survive a process crash.

Same sender and messageId with identical envelope bytes returns the original admission receipt and appends no second delivery. Different ciphertext under that id returns HTTP 409 `Conflict`. SQLite's update path remains necessary for delivery and ack state transitions; admission checks enforce idempotency before using it.

`cc` names one distinct known DID. Only an accepted, locally sealed primary can produce a CC, because copying encrypted ciphertext cannot disclose the plaintext to another key. The returned `cc` outcome is independent. CC never retries the primary and never changes its receipt. It uses a separate messageId, a signed replyTo link and an encrypted `sh.mschf.ratking.mailbox.cc` body carrying the primary sender, messageId and recipient. `open` projects this as `OpenedMessage.cc`; its body is the copied content. Recipient adapters must label it a CC. Its ack belongs only to the copy's messageId, never the primary. No automatic CC retries occur. Restored externally sealed envelopes can send their primary but cannot manufacture a CC without their plaintext.

## Consume

`yield* client.consume(handler, { harness, resume, afterSeq, onLease })` runs one scoped consumer per prepared client. `harness` is supplied by the caller. `resume` is the last lease fence; it must belong to the own DID. Persist `onLease` updates if crash handover is needed. A signed same-DID acquire with the current fence increments generation even when the harness sessionId changes. Without current fence proof, `LeaseHeld` waits until the returned holder expiry and retries.

The lifecycle is acquiring → waiting or consuming → releasing → closed. Renewal sleeps against the **returned expiry**, not the requested TTL. The server caps leases at five minutes. WebSocket reconnect stays inside the watcher. Lease loss cancels intake and reports `LeaseExpired`, `LeaseTakenOver` or `LeaseRenewalFailed`; it never silently acquires a foreign holder's lease. Cancellation and normal return interrupt intake and renewal before releasing the current fence. Release failures are logged and the server expiry remains the fallback. Released leases are immediately available. Stale holders cannot deliver or ack.

The handler must return only after durable recipient intake. **Ack means durably taken in, not turn finished.** The consumer records deliver, invokes the handler, then acks that message under its current fence. A handler failure stops consumption without ack. The caller owns durable checkpoints and intake deduplication; a crash after intake but before ack can invoke intake again. `afterSeq` supplies the caller's recovery cursor.

## Release proof

Run `pnpm check` and `pnpm test`. The desk lands the packet, tags `v1.0.0`, deploys the server separately and proves one live handover. This library does not authorize deployment, publication or recipient activation. Crypto remains unreviewed.
