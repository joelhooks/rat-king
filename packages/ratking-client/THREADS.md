# Owned-thread pass-through

Pass-through runs in the router's Pi receiver. It adds no server or service. It is off unless `threadRouting` names a router.

## Opt in one sender

Add this fragment to Pi configuration. Names here are examples.

```json
{
  "threadRouting": [{ "name": "router", "senders": ["sender"] }]
}
```

Install the updated client on the router and each owner. Each owner's Pi configuration must also list the router in `threadRouting`. That list authorizes the router to attest forwarded messages' original sender and ID. Owners can use the same fragment as the router.

Use `threads: ["work-one"]` instead of `senders` to opt in explicit thread keys or conversation roots. When both lists exist, either match opts in an event. Empty lists match nothing. Omitting both lists enables all verified senders for that router. Omitting `threadRouting`, or setting it to `[]`, preserves existing relay behavior.

A matching message uses its explicit `thread`, conversation root, reply parent or message ID, in that order. New conversations and messages that explicitly address `@router` wake the router. Operator mail bypasses pass-through and wakes the router. Send without a thread or reply reference to address the router directly. `send` and `ask` accept `thread` for explicit follow-ups.

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

Release removes only the caller. Hand-back removes the caller and wakes the router, even if the caller had not claimed yet. Escalation wakes the router without removing any owner. Controls are accepted only from verified names, and they cannot release another sender's ownership.

## Delivery and recovery

Every owner receives a signed forward carrying the original sender, ID and thread. The receiver projects it into normal mail, remembers the original reply target and wakes the owner. The router keeps a quiet copy, including for asks. This quiet copy bypasses attention rules that would otherwise wake the router. Explicit router wakes and owner deliveries also bypass rules that would otherwise hide them.

Encrypted events are resealed separately for every owner. An owner cannot project an encrypted-original forward from a plaintext envelope. A missing name, changed owner identity, retired recipient, unsupported advertised render capability or failed send wakes the router with the original event. Forwarding continues to the other owners after a failure. Already accepted owners may therefore receive an event before the router wakes. Mailbox redelivery can retry forwards; this is not an exactly-once protocol.

The receiver stores owner names and DIDs under `state/thread-routing/<router>.json`. Updates serialize and persist before the control is acknowledged. The XState lifecycle distinguishes unowned, owned, released and handed-back threads. A load failure starts without owners and logs a warning, so new events wake the router instead of disappearing.

A successful send means mailbox admission, not proof that the owner's model processed it. Older readers that advertise an incompatible render list reject the new record type. Readers with no render advertisement cannot prove compatibility; upgrade owners before opting in.

## Rollback and checks

Remove the router's `threadRouting` entry to restore its previous relay or direct delivery behavior. Owner state can stay on disk for a later opt-in. No server migration or live configuration change is part of this patch.

Tests cover the lifecycle as a fast-check command model, signed-envelope replies and controls, and real receiver intake with two owners and partial or retired-recipient failures. They run on the existing Node filesystem and crypto adapters without platform-specific commands. macOS execution still belongs to the desk's platform gate.
