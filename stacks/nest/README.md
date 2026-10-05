# Nest proof stack

This program deploys the mailbox on an inventory-selected host. It composes the user slice, object-store bucket, celld node, CLI and generated mailbox deployment. The node startup guard seeds a deployment pointer before opening listeners. Deployment then replaces that pointer, reloads the internal listener and checks the expected mailbox version and commit through the Worker listener.

Run `node stacks/nest/cli.ts prepare|plan|deploy|listeners|destroy-plan|destroy|teardown-probe` with private inputs:

- `RATS_NEST_INSTANCE`, `RAT_KING_LIVE_NODE`, `RAT_KING_STATE_DIR`
- `RAT_KING_LOCAL_AGENT`, `RAT_KING_LOCAL_DID`
- `RAT_KING_REMOTE_AGENT`, `RAT_KING_REMOTE_DID`
- `RAT_KING_SERVICE_DID`, `RAT_KING_DOCUMENTS`, `RAT_KING_CLI_OUTPUT`
- `RAT_KING_VERSION`, `RAT_KING_COMMIT`
- `RAT_KING_START_APPROVED=true` for the approved manual deployment
- `ALCHEMY_TELEMETRY_DISABLED=1` on every invocation

Build the CLI first using `apps/mailbox/cli/build.ts`. Preparation installs it and provisions the two private identities on their own machines. Only public DID documents return to the operator. Keys stay outside Alchemy state. This is the proof-only file-custody shortcut described in the CLI README.

For an existing P3 deployment, import its resource-state rows into the private `nest/proof` state namespace **before** evaluating the stack. Preserve resource FQNs, instance IDs and the random credential rows. Keep the old state as recovery evidence, but stop using it to drive the resources. The first plan must show the existing resources unchanged, not replacement or destruction. Do not regenerate the bucket credentials to adopt a running store.

The launcher refuses state inside the public repository, including through a symlink. The plan refuses delete and replace actions. For an explicitly approved teardown, run `destroy-plan`, inspect the resource list, then `destroy` and `teardown-probe`. Destroy drains the bucket before stopping its server, purges owned data children, removes deployment files and the explicitly owned provisioned remote agents directory, and removes empty roots. Purge refuses symlinks and paths outside inventory-owned roots. The probe is read-only and prints only pass/fail labels. A failed probe means stop, report leftovers and retain state; never hand-clean the host. Local operator keys and state retention remain the operator’s responsibility.

After deployment, confirm version readback, a no-change plan and the listener probe. The remote CLI uses `$HOME/.config/rat-king/proof.env`. Source it before running `node "$HOME/.local/share/rat-king/bin/mailbox.mjs"` commands. See the CLI README for list, open, lease and ack.
