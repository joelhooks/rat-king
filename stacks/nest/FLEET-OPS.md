# Fleet operations

The nest CLI loads its settings from one private JSON file selected by `RAT_KING_STAGE_CONFIG`. Other application settings do not fall back to environment variables. `stage-config.ts` owns the schema; unknown fields are refused. Keep the file and state directory outside this repository.

The JSON contains:

- `runtime`: the named settings declared by `RuntimeConfig`. Arrays and booleans are JSON values, not shell strings. `HOME` and the inventory location are explicit. Publication metadata is explicit; the desk sets the approved commit before cutover. Listener approval, offline planning and recovery remain separate settings.
- `comms` → `local`: absolute locations for sessions, route receipts and quarantine.
- `comms` → `remote`: the same locations plus an SSH target. Both hosts require readable receipts and existing session/quarantine directories.
- Optional `mintHost`: the SSH target, Node executable, DID and secret-store entry name. Omit it when minting is not authorized.

A private launcher only needs to select the JSON and execute `stacks/nest/cli.ts` with its arguments. It no longer exports individual settings.

## Commands

| Command | Behavior |
| --- | --- |
| `health [--previous file]` | Existing read-only host health and stderr summary. |
| `ship` | Fetch main, require its successful publication-fence workflow, and deploy changed commits serially. |
| `ship-plist` | Print the launchd plist using configured paths. Never install or load it. |
| `digest` | Read-only host health plus comms counts. Append one JSON line to the configured state's `health.jsonl` and print that line. Read the last history line for the previous health sample. |
| `done-bar` | Print separate host counts. Exit zero only when raw intercom sends and lost messages are zero on each host over the last 24 hours. |
| `provision` | Forward mailbox provisioning flags. Without `--secret`, substitute the agent label into `RAT_KING_AGENT_SECRET_TEMPLATE`. |
| `mailbox` | Forward any mailbox CLI command and flags under the same configuration. |
| `mint-host` | Generate signing/agreement keys on the configured target. Refuse an existing secret-store entry. Send private keys only through target-local stdin to the secret store. Print only the DID after successful storage. |

The Python collector is a read-only filesystem adapter. It emits frames; the Effect stream parses and classifies them. Call IDs are scoped to each session file. A send/ask/reply/handover whose result contains `Rat King` is network-routed; other or missing results count as raw intercom. Malformed session lines follow the old collector's skip behavior. Invalid route receipts, missing inputs, SSH failures and collector timeouts fail rather than reporting zero.

Digest history keeps the old field meanings: route, fallback, loss and quarantine counts come from the local host; raw intercom counts sum both hosts. The done-bar is deliberately stricter: it also checks remote losses. A failed measurement does not append a successful digest.

## Continuous deployment

The optional `ship` config owns the source checkout, private release directory, receipts, checkpoint, polling interval, GitHub repository, bot executable, launchd paths and notification identity/names. `ship-plist` prints a plist; the desk installs it. No job is installed by these commands or by this packet.

The Effect loop drives the pinned XState cycle: idle → fetching → waiting-ci → deploying, with failed holding a failed SHA. Each cycle fetches main. It requires the newest GitHub Actions fence check to pass and verifies that its workflow run belongs to the exact main SHA and the publication-fence workflow. Each candidate gets a detached private clone and frozen dependency install before the existing deploy action runs. The loop never checks out or resets the operator's source tree.

Successful and failed SHAs are checkpointed. A checkpoint is pessimistically written before deployment, so an interrupted attempt cannot silently redeploy the same SHA after process restart. Maintenance-busy attempts are recorded as deferred and retried on later cycles. Each completed attempt records start/end epoch seconds, result, whether celld restarted, and restart duration. Uncertain restart outcomes remain null rather than being reported as no restart. One loop runs one deployment at a time; the desk owns the single launchd job and coordination with manual deploys.

Restarting deploys probe the configured maintenance units and backup lock before mutations. In-place mailbox swaps skip that probe. The actual celld start/restart rechecks maintenance while holding the backup lock, writes the configured marker immediately before systemctl, and sets it to done after systemctl and its existing ExecStartPost gate return. Marker timestamps are epoch seconds. Restart duration is recorded; null means the outcome could not be observed. The existing restart/listener gates remain unchanged.

Notifications use the existing mailbox contract, in-memory identity leases and encrypted payloads. Names, sender identity secret and directory come from private config. A rejected note is visible in the launcher error log; it never triggers a second deployment. The desk must verify notification identity/name mapping during installation. Existing listener approval must be explicit in JSON before starting the job. Set metadata to the landed commit, print the plist from that checkout, and install only one job.

The desk owns cutover. Code readiness does not authorize deployment, restarting readers, or minting keys. A mint failure after storage may leave an identity present; inspect the target before retrying. There is no automatic key rotation or mint retry.
