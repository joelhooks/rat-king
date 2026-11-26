# Deploy the standing projection

Mailbox cells still own leases and enforced retirements. The Issuer owns only the enumerable copy. `observedAt` records when the source captured standing, not a promise that a reader can acquire a lease. A missing or conflicting projection row is `unknown`. `recordRetired` still writes only the legacy index; it does not assert cell retirement and is not a source for the projection.

## Before expand: cover every enumeration signer

Use a verified offline Mailbox export and the Issuer auth snapshot or configured public documents. For each DID that signs `listNames`, `listRetired`, or snapshot, compare the cold Mailbox `didDocument` to the Issuer's binding/auth document and the Worker’s configured public DID documents. A signer found only in Mailbox needs its public document supplied before expand. Match DIDs to names using the offline Issuer bindings or the configured DID template. The affected names depend on instance data; the repo and synthetic export do not identify them. No live directory scan or Mailbox lookup is needed.

For the first expand, put those verified public documents in `DID_DOCUMENTS` (preserve the existing entries) or cold-backfill the Issuer auth copy if that route is already available. On an older Worker without the auth backfill route, use configuration. Include only public keys, and verify each signer by a bounded signed request after expand. Do not import standing from a pre-expand export; use the fresh post-expand capture below.

## Expand → seed → replay → cut over

1. Deploy the Worker with `RAT_KING_NAME_STATE_VIEWS` omitted. Do not restart celld. This release expands storage, enables revision pushes and adds the scheduled singleton ticket drain (one invocation per minute). The Nest manifest changes; use the authorized legacy Worker ship path if the prepared ship reports `ManifestChange`. Confirm the bundle version and cron installation. In degraded mode, the name inventory and retirements use the legacy index. Live/idle filters cannot classify rows and never fall back to Mailbox calls.
2. Confirm the pre-expand signer coverage. Configured public documents and Issuer-cached documents authenticate directory requests without Mailbox calls. New registrations, enrollments and operator document puts maintain the Issuer auth copy. A non-enumeration point request still uses its existing auth path.
3. Obtain a checkpointed **cold export captured after expand was serving**, with the durable Mailbox SQLite lineage verified by the backup operator. Put the latest verified database for each exported Mailbox actor beside a JSON manifest shaped as `{"observedAt":1234567890000,"mailboxes":[{"file":"example.sqlite","sha256":"<database digest>"}]}`. Paths are relative to the manifest. Use the manifest digest from the export receipt, not one recomputed solely to make validation pass. An old pre-expand backup cannot establish what changed between its capture and the first revisioned write.

   ```sh
   python3 stacks/nest/seed-name-state.py --manifest "$COLD_MANIFEST" \
     --sha256 "$VERIFIED_MANIFEST_SHA256" --out "$STANDING_SEED"
   ratking seed-name-state --file "$STANDING_SEED" --sha256 "$VERIFIED_SEED_SHA256"
   ```

   The exporter reads only offline SQLite. It checks file digests, SQLite integrity, actor identity and duplicates. The loader verifies the artifact and sends bounded signed batches to the Issuer with the same operator config as `ratking snapshot`. It cannot dispatch Mailbox calls. It is safe to rerun the same artifact after an interrupted batch. Do not fill missing rows from the `retired` index or wake them to seed.

4. Let concurrent revisions and due intent tickets replay. Older seed revisions cannot replace newer observations. Same-revision conflicts stay unknown until a higher revision arrives. Check seed coverage against the export (including the auth documents), backlog size/age, unresolved conflicts, and a named lease expiry/retire/clear canary. Confirm typed point routing and encrypted delivery still use cell truth. Run the many-page proof below against a throwaway worker on the exact target celld build. Do not enable views on a failing proof.
5. Enable `names`, `retired`, `snapshot` separately in the comma-separated `RAT_KING_NAME_STATE_VIEWS`, checking each before the next. Upgrade enumeration clients before enabling a view that can return the new `unknown` status. `snapshot` is a client composition of `listNames` and `listRetired`; it sends `snapshot=true` to both and uses its own switch. On the live target do not run whole-directory scans to qualify it; use the throwaway fixture for bulk checks and a bounded named canary for target readback.

Rollback is a Worker config update: remove the affected view from `RAT_KING_NAME_STATE_VIEWS` (or omit it for all three). Leave tables, ticket drain and outbox intact. Do not restore a Worker build that calls Mailbox from directory reads. Delete `scan_reads` and `ScanBudgetSpent` in a separate **after cutover** change.

## Throwaway proof

```sh
CELLD_BIN=/absolute/path/to/celld ESBUILD_BIN=/absolute/path/to/esbuild \
  node apps/mailbox/test/cellwake-celld.ts
```

The test uses a local disposable project, loopback, signed requests, 6,200 issuer rows and already-due tickets. It checks both `/state` and the celld startup log for no Mailbox starts, then deliberately opens one named Mailbox as a positive control and checks that its committed lease reaches the Issuer. Never point this proof at a live mailbox.

## Known limits

- On celld, the cell writes the retry alarm through the storage transaction view, not `ctx.storage.setAlarm()` inside `transactionSync()`. The public root alarm API can yield past the synchronous transaction. The ordinary outgoing DO RPC stays in the originating event, where celld holds egress until durability is proven.
- Direct and retried retirement share the same ticket driver. For a named successor, the ticket records the resolved DID and expects a registered, unretired Mailbox. After an applied source reply (including a replay), it makes one named successor call. A lost reply leaves the ticket due. A definite missing or retired successor records the compensation decision before restoring the previous retirement, fenced by the source revision that applied the retire. An ambiguous compensation replays that recorded decision; it never overwrites a newer revision. A role successor keeps its existing route preflight. None of these point calls run on a directory request.
- A durable acquire-clear with failed wake-entry publication may take until the next named wake. It is not repaired by a directory read.
