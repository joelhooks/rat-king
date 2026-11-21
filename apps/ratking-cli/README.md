# ratking

The Rat King command line. It is a client of `@rat-king/ratking-client`, the same core the Pi tool uses.

```
ratking send  --to <name> [--cc <name>]... [--summary <line>] (--body <text|-> | --record <file> --type <nsid>) [--encrypt] [--cc-on-purpose]
ratking ask   --to <name> --body <text|-> [--summary <line>] [--wait --timeout <s>] [--due-by <epoch-ms>]
ratking reply <id> --body <text|-> [--summary <line>] [--only-sender] [--to <asker>]
ratking inbox [--all] [--after <seq>] [--hold]
ratking read <id>
ratking thread <id>
ratking pending
ratking whoami
ratking doctor
ratking health <name> [--as operator]
ratking attention show [--of <name>]
ratking attention set [--model none|jev] [--body never|summary|full] [--now <0..1>] [--later <0..1>] [--judgment <text>] [--timeout-ms <n>]
ratking attention dnd <90m|2h|1d> [--note <text>]
ratking attention available
ratking attention allow|refuse|forward <name>... [--remove]
ratking attention mute (--thread <ref> | --group <ref>) [--remove]
ratking attention test [--message <id> | --from <name> --kind message|ask|reply|data [--cc] [--thread <ref>] [--group <ref>]]
ratking attention log [on|off]
ratking filter add '<rule-json>'
ratking filter remove <id>
ratking filter list
ratking identity | provision | retire | unretire | retired | traffic
ratking retired-import --file ./retired-names.txt
ratking snapshot --out <new-directory>
ratking resolve --names <file> --out <new-file>
```

Client commands take `--as <name>` (default `RATKING_NAME`) and `--json`. `health` defaults its signer to `operator`, not the inspected name.

## Exit codes

- `0`: success, including `--help` and `--version`.
- `2`: usage errors, including unknown commands or flags, missing required inputs and invalid flag values. Parser failures print a JSON object with `failed`, `why` and `next` on stderr. Run the suggested `--help` command to see accepted inputs. Commands with no required inputs still accept an empty argument list.
- `1`: unhandled runtime failures, such as an unreadable resolve input or failed operator configuration.

Existing client refusal codes remain unchanged: `2` for rejected requests, `3` for partial or uncertain outcomes, and `4` for a held reader lease. Exit `2` is therefore not exclusive to parser errors. The standalone `apps/mailbox/cli/main.ts` uses the same parser exit rule.

## Identity

Config is the Pi tool's: `RATKING_CONFIG`, else `~/.config/rat-king/pi.json`, with the name's key in the host secret store. `--as` is accepted only for names whose key this machine holds. `whoami` prints the name, DID, key source and the current lease holder.

## Lease rules

- `send`, `ask` and `reply` sign with the name's key and never take the lease, so a live Pi holding that name is undisturbed.
- `inbox`, `read`, `thread` and `pending` peek. They list and open, and never deliver, ack or take the lease.
- `inbox --hold` alone consumes: it acquires the lease, delivers each unsettled message, acks it after it is shown, and releases. If a live holder exists it refuses `LeaseHeld`, names the holder's session, and takes nothing.

## Health

`ratking health <name>` reads one name's operator-only `mailbox.nameHealth` projection. It shows the lease holder, generation and expiry, the local reader heartbeat when it matches that lease, the last ack, the oldest delivered wake's id, sender and age, and the count of delivered-but-unacked quiet copies. It reads local Herdr pane status only when a matching local heartbeat establishes locality. It shows a visible current-session turn record when one exists; encrypted or absent records remain unknown. The verdict is `ok`, `reader stuck`, `agent not taking turns`, or `unknown (why)`.

A delivered wake becomes overdue strictly after 180 seconds while its lease is live. Reader progress uses the existing five-minute threshold. Quiet copies do not trigger the wake verdict. Unknown or incomplete observations never claim health. Human output uses the owned TUI primitives in twelve bounded lines; JSON retains full identifiers and facts. The command does not attach, mint identities, take or renew leases, deliver, ack, change preferences, send mail, or restart processes. No restart option is provided.

Senders declare per-recipient `woke` and `wakeReason` at admission, outside the encrypted envelope. `ask` wakes its recipients; ordinary CC, explicit quiet mail and data records do not. The health projection reads those declarations without decrypting content. Legacy signed plaintext payloads can supply missing intent. Legacy encrypted delivered mail without intent remains incomplete, and the quiet-copy count is then a lower bound. The projection returns metadata only, never envelopes, ciphertext, summaries or bodies. A missing operator key or refused projection produces an unknown screen.

Health reads have a ten-second deadline. The server examines at most 10,000 delivered receipts per name and marks larger snapshots incomplete. It reads at most 128 legacy envelopes for plaintext intent fallback; messages with declared intent need no envelope read. Visible turn lookup scans at most 100 traffic pages, with a ten-second deadline. Normal turn records are encrypted to their owners and therefore remain unknown to the operator; a sender-declared turn-status metadata field is a follow-on, not permission to lease owner keys.

## Attention

`ratking filter add '{"id":"quiet-fleet","match":{"from":"fleet/*"},"route":"quiet"}'` adds or replaces a first-match receiver rule; `remove <id>` deletes it and `list` shows local hits and expiry (`--json` includes full rules). Routes are `wake`, `quiet`, `digest` with `minutes` (1–1440), and `hide`, with optional ISO `until`; filters never change durable delivery, operator mail or direct asks.

Writes read the stored preferences, change one thing and put the whole record back, so model, mutes, lists and probabilities you did not name stay as they were. Probabilities are decimals 0..1 at the shell. `attention test` is read-only: it loads your levers, runs the same `attend` the reader runs and prints the verdict, and calls neither `putPreferences` nor `putStatus`. If levers are switched off (`RATKING_ATTENTION`), it says so and the verdict is the plain intent default. `attention log` only shows and toggles the `log` preference; no outcome store exists yet, so it lists no outcomes.

## Operator commands

`identity`, `retired` and `traffic` mount the `apps/mailbox/cli` commands unchanged. `provision`, `retire` and `unretire` use the same remote operations, then update the host-local retired listing overlay after success. They need the operator `RAT_KING_*` configuration described in `apps/mailbox/cli/README.md`; the overlay also uses the local Pi configuration. If the remote operation succeeds but the local update fails, the error states that partial outcome. The standalone mailbox CLI never changes this overlay.

### Local retired listing overlay

`ratking retire --as <name> [--successor <name>]` signs with the name's local key and prints a JSON receipt. Stop the reader first. The CLI refuses if its lease check finds a live reader, but the check and retirement are separate requests: do not start another reader during retirement. If the local key is missing, use `ratking retire --name <name> [--successor <name>]` with operator authority.

`ratking retired-import --file ./retired-names.txt` reads one name per line, ignores blank lines, and validates the entire file before writing. It prints `{ "added": 12, "already": 3 }`. Repeating an import preserves existing retirement metadata. It makes no network requests and needs no operator identity.

The overlay lives at `<state>/retired.json`, beside the configured local state. It uses the directory lock and a mode-0600 temporary file plus rename. Importing or changing the overlay never changes `directory.json`, peer documents, sender-name mappings, recipient resolution or name-claim guards.

Command-issuer clients hide overlay names from their default lists. `all: true` includes them marked `retired`; `status: retired` lists them locally. Live and idle filters still require a service issuer. Service-issuer listing ignores the overlay and continues using the issuer's directory.

Own retirement records a local tombstone. Successful registration, provisioning, lease acquisition or `ratking unretire` clears the name's tombstone. A normal peer-document lookup does not clear it. The overlay is per host: remote operator changes are not pushed into other hosts' files. Import only a separately verified retired-name list; absence from this overlay is not proof of a live lease. An unreadable overlay warns and leaves listing visible rather than blocking communication.

### Complete issuer snapshots

`ratking snapshot --out <new-directory>` exports the issuer's complete live and retired name lists for callers sync. It uses the existing signed transport and leases the credential named by `RAT_KING_OPERATOR_IDENTITY` from agent-secrets. Configure `RAT_KING_ENDPOINT`, `RAT_KING_SERVICE_DID` and `RAT_KING_ISSUER_LABEL` alongside that secret name. The label is the issuer's placement label, not its URL or DID. The command never prints the credential.

Run from the repository root with that operator environment loaded:

```sh
node apps/ratking-cli/bin/ratking.ts snapshot --out "$HOME/ratking-snapshot-$(date -u +%Y%m%dT%H%M%SZ)"
```

The output parent must exist and be writable. The output directory must not exist. Every page of both contracts must succeed before any snapshot file is written. There is no page cap. A repeated cursor produces `RepeatedCursor` rather than an incomplete snapshot.

The command stages `names.json`, `retired.json` and `issuers.json` beside the destination, then publishes the directory with one rename. Files use mode `0600`; the directory uses `0700`. The two list files share a fresh `snapshot` run id, `complete: true` and exact `total` values. Neither contains a remaining cursor. `issuers.json` maps live names to the configured placement label. Collection rejects conflicting documents for the same name; identical duplicates retain the first configured placement.

Success prints one JSON receipt containing `snapshot`, `totals`, per-issuer `pages` and file `sha256` hashes. Failure prints a JSON diagnostic on stderr with `error`, `failed`, `why` and `next`, exits nonzero and does not publish a bundle. Existing output stays unchanged. Use a new output directory when retrying an `OutputExists` error. These exports are complete traversals, not an issuer-wide transactional read: names can change while pages are fetched.

### Per-name resolution

`ratking resolve --names <file> --out <new-file>` reads a JSON array of unique, nonempty names. It tries the local directory first, then canonicalizes aliases and refreshes the derived DID through the operator's signed mailbox client. It never sends mail, mints identities or updates the local directory.

Load the same four `RAT_KING_*` operator settings used by `snapshot`. The local directory, reserved names, configured documents and DID template come from `RATKING_CONFIG` (otherwise `~/.config/rat-king/pi.json`). The operator endpoint and service DID, not the Pi endpoint, own the refresh requests.

Run from the repository root with that environment loaded:

```sh
node apps/ratking-cli/bin/ratking.ts resolve --names "$SYNC_INPUTS/selected-names.json" --out "$SYNC_INPUTS/resolve-run.json"
```

The output is `{resolved: {name: {did, document}}, unresolved: [{name, reason}], total, run}`. Keys retain the requested names, including aliases. Each lookup has a ten-second deadline, with at most four in flight. A failed or timed-out lookup does not abort the rest. Reasons are only `unknown-name`, `refresh-failed`, `invalid-document` or `did-mismatch`, never exception text. A timeout uses `refresh-failed`. Documents pass the mailbox client's public-document schema; private JWK fields refuse and unknown fields are not exported.

The output parent must exist and support hard links. The command stages a `0600` file beside the destination and atomically links it into place without overwriting another writer. Success, including partial resolution, prints one JSON receipt with `resolved` and `unresolved` counts, `total`, a fresh `run` and the file's `sha256`. Bad input, configuration or publication fails nonzero, prints `failed`, `why` and `next` on stderr, and does not publish a file. Existing output stays unchanged.

Secret Cell's `callers_sync.py --directory` expects the **inner `resolved` map**, not this command's run envelope. Extract it into a new private file before supplying it to callers sync, and retain the envelope and unresolved list for review:

```sh
(umask 077; set -C; jq -e '.resolved' "$SYNC_INPUTS/resolve-run.json" > "$SYNC_INPUTS/resolved.json")
```

Use fresh filenames for each run. This command resolves an explicitly selected list; it does not select callers or attest issuer-snapshot completeness.

## Output

Human output follows the TUI kit grammar, `🐀 <verb> <party> · <short facts>`, callsign only. `--json` prints one JSON document, `{"command", "ok", ...}`. Errors print the literal prompt (`Tag: why`, `Accepted`, `Fix`, `Debug`), or `{"ok": false, "error": {tag, why, accepted, fix, debug}}` with `--json`.

Exit codes: 0 done, 2 refused, 3 uncertain or partial (a resend can duplicate), 4 `LeaseHeld`.

## Run

`node apps/ratking-cli/bin/ratking.ts <command>`, or the `ratking` bin of this package.
