# Owned-thread pass-through

Pass-through runs in the router's Pi receiver. It adds no server or service. It is off unless `threadRouting` names a router.

## Opt in one sender

Add this fragment to Pi configuration. Names here are examples.

```json
{
  "threadRouting": [{ "name": "router", "senders": ["sender"] }]
}
```

Install the updated client on the router and each owner. Owners do not need router configuration to project a forward. A forward names its router, and the receiver requires that name to match the verified signed sender. Earlier forwards without the router field use their verified sender as the router. The original sender and ID are the router's signed attestation, not an independently verified original signature.

Use `threads: ["work-one"]` instead of `senders` to opt in explicit thread keys or conversation roots. When both lists exist, either match opts in an event. Empty lists match nothing. Omitting both lists enables all verified senders for that router. Omitting `threadRouting`, or setting it to `[]`, preserves existing relay behavior.

A matching message uses its explicit `thread`, conversation root, reply parent or message ID, in that order. Thread routing takes custody only when it successfully passes the event to every owner. New conversations, direct `@router` addresses, operator mail, disabled senders and unsuccessful forwards use the existing relay or direct delivery path. A reader that is also a legacy relay `name` still forwards those events to its relay `to`. A router on the relay `to` side also considers signed `relay#message` originals for pass-through. Other relay records retain their existing handling and acknowledgments. On a front relay's target, successful pass-through confirms custody to the upstream relay only after all owner sends are accepted. A failed custody confirmation restores the target's normal relay delivery rather than leaving only a quiet copy.

Send without a thread or reply reference to address the router directly. `send` and `ask` accept `thread` for explicit follow-ups. When dispatching an existing conversation to an owner, set `thread` to the original sender's root so the owner's first reply claims the right conversation.

## Owner calls

Each call sends one signed control record to the router. `claim` remains the reader-lease action; thread ownership uses separate actions.

```ts
ratking({ action: "thread-claim", to: "router", thread: "work-one" });
ratking({ action: "thread-release", to: "router", thread: "work-one" });
ratking({
  action: "thread-escalate",
  to: "router",
  thread: "work-one",
  message: "A decision is needed",
  encrypt: true,
});
ratking({
  action: "thread-handback",
  to: "router",
  thread: "work-one",
  message: "Not mine",
  encrypt: true,
});
```

A first reply to a forwarded message claims its thread automatically. A reply to a configured router's own dispatch also claims that dispatch's root. The reply goes to the original sender, not the router. Other owners remain subscribed. If the reply succeeds but its automatic claim fails, the result reports partial success and directs the owner to retry only `thread-claim`.

Release removes only the caller. Hand-back removes the caller and alerts the router through its existing relay or direct path, even if the caller had not claimed yet. Escalation uses that path without removing any owner. Controls are accepted only from verified names, and they cannot release another sender's ownership.

### Claim authorization

A router can restrict new claims with an optional `owners` list:

```json
{
  "threadRouting": [
    {
      "name": "router",
      "senders": ["sender"],
      "owners": ["project/", "reviewer"]
    }
  ]
}
```

An exact name matches only itself. A trailing slash matches that namespace prefix, so `project/` matches `project/desk` but not `project-other/desk`. An empty list denies every new claim. When `owners` is absent, any verified name can claim, as before. Every accepted claim logs `Thread claimed` with owner, router and thread. Refused claims log `Thread claim refused`. The allowlist gates claims, not releases or escalations, and does not revoke existing subscriptions. Owners should release subscriptions that the router no longer intends to retain.

## Delivery and recovery

Every owner receives a signed forward carrying the original sender, ID, thread and delivery intent. The receiver projects it into normal mail and remembers the original reply target. Normal attention decides whether it wakes: quiet, cc and delegated originals keep their intent at the owner. Non-pass-through messages keep their original intent on the fallback path too. The router keeps a quiet copy only after successful pass-through, including for asks. That quiet copy bypasses attention rules that would otherwise wake the router. Failed eligible forwards retain a fail-open wake marker when the existing fallback path delivers them directly.

Encrypted events are resealed separately for every owner. An owner cannot project an encrypted-original forward from a plaintext envelope. A missing name, changed owner identity, retired recipient, unsupported advertised render capability or failed send returns the original event to the router's existing relay or direct path. Forwarding continues to the other owners after a failure. Already accepted owners may therefore receive an event before the router wakes. Mailbox redelivery can retry forwards; this is not an exactly-once protocol.

The receiver stores owner names and DIDs under `state/thread-routing/<router>.json`. Updates serialize and persist before the control is acknowledged. The XState lifecycle distinguishes unowned, owned, released and handed-back threads. A load failure starts without owners and logs a warning, so new events wake the router instead of disappearing.

A successful send means mailbox admission, not proof that the owner's model processed it. Older readers that advertise an incompatible render list reject the new record type. Readers with no render advertisement cannot prove compatibility; upgrade owners before opting in.

## Known limits from the review

- **F4: owner identity changes.** Entries are keyed by DID. A delegated worker's DID or a rekeyed owner's old DID can remain subscribed and fail the current name-to-DID check on every forward. The router falls back rather than dropping the event, but another identity cannot release that stale entry. Name-keyed ownership and stale-entry cleanup remain follow-ups.
- **F6: dispatch roots.** A fresh router dispatch has its own root unless the router sets `thread` to the sender's root. Automatic claims use the dispatch's root; the receiver cannot infer the original root from a hand-written relay body. Set `thread` explicitly or claim the original root explicitly.
- **F7: journal hygiene.** An unreadable journal starts empty. A later successful save can overwrite that unreadable file without retaining a backup. Ownerless entries are not pruned, and every control rewrites the full journal. Backup and pruning work remains deferred.
- **F8: direct-address aliases.** Mention detection recognizes only `@<configured router name>`, not reserved aliases or short forms. Use the configured canonical name for a direct address.

## Rollback and checks

Remove the router's `threadRouting` entry to restore its previous relay or direct delivery behavior. Owner state can stay on disk for a later opt-in. No server migration or live configuration change is part of this patch.

Tests cover the lifecycle as a fast-check command model, claim authorization and audit logging, signed-envelope replies and controls, both legacy relay endpoints, fallback attention, unconfigured owners, and partial or retired-recipient failures. Regression properties for F1, F2 and F5 also fail against the original implementation at `5ac1ed1`. They run on the existing Node filesystem and crypto adapters without platform-specific commands. macOS execution still belongs to the desk's platform gate.
