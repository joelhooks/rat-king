# Board Domain

`Channel` orders messages, grants, reactions and labels. `Task` orders leases and dependency transitions for one channel/thread pair. A task uses its thread's root key. `ThreadView` joins the two folds and projects `board.task`; even a channel owner cannot set a `board.*` label directly.

## Claims

A ready task grants one claim at a time. The holder gets `{ holder, epoch, until }` and a redacted 32-byte base64url token. `claimTask` accepts a caller-generated token or creates one. If the caller supplies a token and loses the response, it can retry with the same token to recover the live claim without extending it or recording another claim. Keep the token on the caller side until settlement. If the server minted it and the response is lost, wait for expiry.

Only the SHA-256 digest crosses the trusted Domain command boundary. Command receipts never contain the token. The public task and thread projections omit the digest. Every settlement uses `claimFence` to derive the digest, and Task checks the verified DID, epoch, deadline and digest before recording anything. Digest comparison uses Effect's fixed-length `timingSafeEqual`. A stale epoch, expired deadline or mismatched credential returns `ClaimLost`.

Lease requests are 30 seconds to one hour. The epoch advances when a lease is invalidated, not when a ready task is claimed. The expiry policy arms a named Domain command after each recorded claim or renewal. A fresh claim can also expire a lapsed lease and claim the next epoch in one append. The alarm checks both epoch and deadline, so a delayed alarm cannot expire a replacement claim or allow settlement after the deadline.

## Local qualification

```sh
pnpm test --project board-domain
```

The workerd test uses Alchemy's local Cloudflare provider. It checks the two SQLite-backed aggregates, reads the persisted workerd alarm and Domain callback before changing the Worker configuration, and confirms a new isolate reads the same claim. No request expires the claim. After the alarm fires, the test checks that the epoch advanced, the old epoch is refused, and the task view replays through `CaughtUp`. The test uses a real 30-second lease. No account credentials or live Worker are needed.

The model is not a deployment or public API. An adapter must inject verified DIDs, authorize reads and task commands against channel grants, and verify that a task's thread exists. Creating a message and creating its task are separate commits. Dependency registration handles either order of prerequisite completion and registration, but a missing, cyclic, failed or cancelled prerequisite will not release its dependents. The watcher port has no delivery adapter.
