# Mailbox restore drill

`restore-drill` is an opt-in, local Linux nest action. It never calls the production restore, deploy or listener lifecycle. Run it on the mailbox host, from the source checkout, with Node 24+, Python 3.12+, systemd and permission to create a system transient service through `sudo -n`.

## Configuration

Add `restoreDrill` beside `runtime` in the private fleet stage file. Example values are invented:

```json
{
  "restoreDrill": {
    "bucket": "example-mailbox-cells",
    "celld": "/opt/example/bin/celld",
    "knownName": "example/desk",
    "node": "/usr/local/bin/node",
    "receipts": "/srv/example-state/restore-drill.jsonl",
    "scratchParent": "/srv/example-scratch",
    "weed": "/opt/example/bin/weed"
  }
}
```

The scratch parent and receipt parent must already exist. The scratch parent cannot overlap the backup share or any production data root declared in `runtime.RATS_NEST_INSTANCE`. The receipt cannot live inside those protected roots. Keep instance configuration, receipts and actual host paths outside the public repository.

Run:

```sh
RAT_KING_STAGE_CONFIG=/srv/example-state/fleet.json node stacks/nest/cli.ts restore-drill
```

The action requires fleet stage and explicit drill settings. Missing settings leave it unavailable. It uses the existing `runtime.RAT_KING_BACKUP_ROOT` and reads that share only. It refuses a running backup or the 10:00–10:14Z backup window.

## Proofs

1. Select the newest dated directory with a published manifest. Never fall back to an older publication when the newest is incomplete or corrupt. This drill accepts format 4 only.
2. Check free disk space against archive bytes plus extracted bytes, with 20% headroom and another GiB. Copy while checking SHA-256 and byte length. Stream-extract only regular files/directories under `celld` and `seaweedfs`; refuse links, traversal, duplicates and inventory overruns. Compare both archive and actual extracted inventories exactly with the manifest.
3. Start fresh child processes in a unique `restore-drill-<random>.service`, with `PrivateNetwork=yes`, `PrivateTmp=yes`, a runtime deadline and control-group teardown. Allocate ten ephemeral ports inside the isolated loopback namespace. Generate scratch S3 credentials. Never load production environment files or signing keys.
4. Read the restored application's version and health. Activate restored mailbox cells through the scratch internal HTTP interface and inspect current SQLite epochs read-only. Derive the newest message ID and per-mailbox message/event counts from that restored data.
5. Temporarily add an in-memory ephemeral signer's public key to the copied deployment's public authorization bindings. Keep the restored application code unchanged. Read the newest message envelope through `mailbox.list`; paginate every inspected mailbox and compare event/message totals with zero tolerance. Resolve the configured name through the restored directory, falling back to the restored issuer template for legacy names. Activate its mailbox through `resolveLease`, then prove its saved lease record read-only. An expired lease is valid backup evidence; the drill never renews it. Restore the copied authorization bindings in `finally`.
6. Stop owned children, prove the unique unit and cgroup have gone, then delete only the root whose marker, device and inode match this run. A cleanup failure keeps the run failed and retains the root for inspection. Append and fsync one private JSONL receipt. A missing proof or teardown field cannot pass the typed receipt contract.

Format 4 does **not** contain logical mailbox row counts. The manifest proof is the exact filesystem inventory. Logical counts use the restored SQLite data as their baseline and the scratch HTTP API as their readback. These are separate claims, not invented manifest fields.

## Qualification and follow-ups

The property test covers publication selection, checksum/extraction round trips, marker/inode teardown refusal, symlink containment, required proof gates and failed-run receipts. Full scratch-service/API qualification still needs a successful live run. The first live attempt was cancelled on an operator load hold before services started; its failure receipt and complete teardown are private report artifacts, not a passing restore proof.

Do not schedule this action until that live proof passes. A separate approved step can install a weekly timer outside the nightly backup window, run it through the fleet heavy-work lock, and have the health digest consume the configured JSONL's latest receipt and age. No timer, persistent unit or digest reader is installed by this packet.
