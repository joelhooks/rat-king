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

The Python collector is a read-only filesystem adapter. It emits frames; the Effect stream parses and classifies them. Call IDs are scoped to each session file. A send/ask/reply/handover whose result contains `Rat King` is network-routed; other returned results count as raw intercom. Calls without a tool result count as unanswered, not raw, and do not affect the done-bar. Digest exposes their aggregate as `unanswered_24h`; older history without that field still parses. Malformed session lines follow the old collector's skip behavior. Invalid route receipts, missing inputs, SSH failures and collector timeouts fail rather than reporting zero.

Digest history keeps the old field meanings: route, fallback, loss and quarantine counts come from the local host; raw intercom counts sum both hosts. The done-bar is deliberately stricter: it also checks remote losses. A failed measurement does not append a successful digest.

## Continuous deployment

The optional `ship` config owns the source checkout, private release directory, receipts, checkpoint, polling interval, GitHub repository, bot executable, launchd paths and notification identity/names. `ship-plist` prints a plist; the desk installs it. No job is installed by these commands or by this packet.

The Effect loop drives the pinned XState cycle: idle → fetching → waiting-ci → deploying, with failed holding a failed SHA. Each cycle fetches main. It requires the newest GitHub Actions fence check to pass and verifies that its workflow run belongs to the exact main SHA and the publication-fence workflow. Each candidate gets a detached private clone and frozen dependency install before the existing deploy action runs. The loop never checks out or resets the operator's source tree.

Successful and failed SHAs are checkpointed. A checkpoint is pessimistically written before deployment, so an interrupted attempt cannot silently redeploy the same SHA after process restart. Maintenance-busy and restart-policy exclusions defer the candidate, not fail it. The checkpoint stores its retry deadline. Each poll still fetches main; a newer SHA supersedes the deferred one. An unchanged deferred SHA skips install/deploy until its deadline. Each completed attempt records start/end epoch seconds, result, whether celld restarted, and restart duration. Uncertain restart outcomes remain null rather than being reported as no restart. One loop runs one deployment at a time; the desk owns the single launchd job and coordination with manual deploys.

Restarting deploys include celld changes and storage-unit changes that cascade through Requires. `ship.restart.minIntervalHours` defaults to 6. Optional `window` uses `startHourUTC` inclusive and `endHourUTC` exclusive; it can wrap midnight. Equal endpoints allow all hours. `noticeSeconds` defaults to 60. Allowed restarting candidates send one signed plaintext pre-notice to the configured recipients, wait that delay, then recheck policy and maintenance. A failed pre-notice defers the restart. In-place mailbox swaps skip the restart policy and notice.

Worker/config files stage before service lifecycle commands. Each unit writes its declaration and reloads systemd before its own restart. Helper script hashes are readiness dependencies, not process restart inputs. Only binary/environment (or storage identity) changes restart the process. Old helper-inclusive fingerprints project onto those same process inputs without forcing a migration restart. Operator bundles use the entrypoint directory as esbuild working directory, so candidate clone paths do not change bytes.

The actual target/dependency start or restart rechecks maintenance under the backup lock. Marker timestamps are epoch seconds at the control boundary, not deployment start. Receipts measure the target systemd ActiveExit-to-ActiveEnter monotonic interval, including drain and dependency startup. InvocationID distinguishes an actual transition from an idempotent start. Uncertain outcomes remain null. The existing restart/listener gates remain unchanged. A real storage restart may still include storage startup time; the desk must verify its full downtime before enabling the loop.

Notifications use the existing mailbox contract, in-memory identity leases and signed plaintext payloads so the operator feed can read them. The payload contains only deployment SHA/result and restart facts, never keys or private configuration. Names, sender identity secret and directory come from private config. Optional `ship.notify.config` selects Pi config; otherwise the existing Pi settings port uses configured HOME. The notifier reuses Pi Directory resolution, including reserved names/aliases and configured public documents, and resolves all targets before sending. A rejected note logs the candidate SHA, recipient, underlying failure tag and sanitized reason; schema inputs are withheld and key-shaped tokens are redacted. Notification failure never triggers a second deployment. The desk must verify notification identity/name mapping during installation. Existing listener approval must be explicit in JSON before starting the job. Set metadata to the landed commit, print the plist from that checkout, and install only one job.

The desk owns cutover. Code readiness does not authorize deployment, restarting readers, or minting keys. A mint failure after storage may leave an identity present; inspect the target before retrying. There is no automatic key rotation or mint retry.
