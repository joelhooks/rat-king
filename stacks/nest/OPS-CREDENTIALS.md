# Nest systemd credentials

Set `RAT_KING_SECRET_SOURCE=systemd` in the service environment, or in the Nest stage `runtime`. If both set it, they must agree. Without either setting, legacy commands still use `agent-secrets`. Pi only supports the legacy source and refuses systemd mode before reading its config.

Systemd provides `CREDENTIALS_DIRECTORY`. Each configured reference is the ID to the left of `:` in `LoadCredentialEncrypted=`, not the encrypted blob's filename, a path, or a secret value. IDs match `[a-z0-9_][a-z0-9_-]*`. The reader checks the mounted file and removes exactly one final LF or CRLF. JSON identity decoding is unchanged. A missing slot never falls back to another source.

| Consumer | Config reference | Mounted value |
| --- | --- | --- |
| Nest alarm | `RAT_KING_STAGE_CONFIG` → `alarm.notify.secret` | Signer identity JSON |
| Nest alarm with optional push | `alarm.push.secret` | Push credential, only if push is enabled |
| Nest operator reads | `runtime.RAT_KING_OPERATOR_IDENTITY`; named health uses `alarm.notify.secret` | Operator identity JSON |
| Billing relay | `RAT_KING_BILLING_PULL_SLOT`; fixed `rat_king_script_billing-alerts_identity` | Pull token; signer identity JSON |
| Front-desk relay | `RAT_KING_FRONT_DESK_SIGNER` | Signer identity JSON; the puller has a separate token slot |
| Prepared ship (separate cutover) | `ship.notify.secret`; stage operator identity; instance mailbox identity, object-store access and secret keys, and network auth refs | Notification/operator and mailbox identity JSON; object-store and network credentials |

Stage credential references, including optional `mintHost.secretName`, `runtime.RAT_KING_MODEL_GATEWAY_SECRET_NAME`, and the ID rendered from `runtime.RAT_KING_AGENT_SECRET_TEMPLATE`, must pass slot validation in effective systemd mode even if a particular command does not read them. The relay commands take an absolute `RATKING_CONFIG`; its `state` must be absolute. Front-desk also takes `RAT_KING_FRONT_DESK_TO` and `RAT_KING_FRONT_DESK_CC` as names, not slots.

## Front-desk journal

`nest ops-front-desk-send --stdin` returns exit 65 and no receipt when an existing ID cannot be authenticated. Keep that ID unacknowledged for review and continue later IDs. A missing journal key with existing rows creates a private `.journal-key-loss` marker, logs one warning, and installs a fresh key. The old rows remain in place.

Run `nest ops-health --service front-desk` with the relay UID and the same source mode and `RATKING_CONFIG`, without mounting a signer. It reads metadata, not journal contents. It warns at 10,000 rows, 64 MiB, or when the key-loss marker is present. At the row limit the byte count can be a lower bound. Do not grant the ops socket access to the relay state directory.

Leave `RAT_KING_FRONT_DESK_REDELIVERY_SECONDS` unset. Enable it only once the upstream terminal-ack contract establishes a safe redelivery bound. The option removes only timestamped, completed rows strictly older than the bound. It never removes the current ID, pending rows, legacy rows without a completion timestamp, or rows while key-loss review is pending.

Regenerate the committed mailbox client bundle with `sh packages/mailbox-client/bundle.sh` after changing its wire adapter.
