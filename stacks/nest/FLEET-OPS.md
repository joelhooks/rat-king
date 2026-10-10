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
| `digest` | Read-only host health plus comms counts. Append one JSON line to the configured state's `health.jsonl` and print that line. Read the last history line for the previous health sample. |
| `done-bar` | Print separate host counts. Exit zero only when raw intercom sends and lost messages are zero on each host over the last 24 hours. |
| `provision` | Forward mailbox provisioning flags. Without `--secret`, substitute the agent label into `RAT_KING_AGENT_SECRET_TEMPLATE`. |
| `mailbox` | Forward any mailbox CLI command and flags under the same configuration. |
| `mint-host` | Generate signing/agreement keys on the configured target. Refuse an existing secret-store entry. Send private keys only through target-local stdin to the secret store. Print only the DID after successful storage. |

The Python collector is a read-only filesystem adapter. It emits frames; the Effect stream parses and classifies them. Call IDs are scoped to each session file. A send/ask/reply/handover whose result contains `Rat King` is network-routed; other or missing results count as raw intercom. Malformed session lines follow the old collector's skip behavior. Invalid route receipts, missing inputs, SSH failures and collector timeouts fail rather than reporting zero.

Digest history keeps the old field meanings: route, fallback, loss and quarantine counts come from the local host; raw intercom counts sum both hosts. The done-bar is deliberately stricter: it also checks remote losses. A failed measurement does not append a successful digest.

The desk owns cutover. Code readiness does not authorize deployment, restarting readers, or minting keys. A mint failure after storage may leave an identity present; inspect the target before retrying. There is no automatic rotation or retry.
