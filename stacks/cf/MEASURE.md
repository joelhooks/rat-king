# Measure the Cloudflare preview

Code-ready harness. The desk runs these steps on `<deploy-host>` after approval. Nothing here authorizes deployment. Use test identities only. Do not point a test identity at a real agent, import fleet keys, add routes, enable a gateway or change the faux model.

## 1. Pin the candidate and create private inputs

Use Node and pnpm 11.28.2. Run from the rat-king checkout containing this harness. Keep the same checkout, commit and external Alchemy state through teardown. Do not deploy another preview into the same deterministic Worker name while this run exists.

```bash
export PATH="$HOME/.local/bin:$PATH"
export RUN_PARENT="$HOME/.local/state/rat-king-cf-measure"
mkdir -p "$RUN_PARENT"
chmod 700 "$RUN_PARENT"
export RUN="$RUN_PARENT/$(date -u +%Y%m%dT%H%M%SZ)"
node tools/cf-measure/cli.ts identities --directory "$RUN" --count 6
mkdir "$RUN/state"
chmod 700 "$RUN/state"
git rev-parse HEAD > "$RUN/candidate"
```

The generator refuses an existing target or a target inside the repository, including symlinked parents. It creates six reader identities, one service identity and one hosted identity. Each identity has two independent P-256 keys. DIDs include a fresh run UUID and end in `.test.invalid`. `inputs.json` contains all private identities; `hosted.json` is the single identity the stack expects. Both are mode 600. `documents.json` contains public keys only. The directory is mode 700. Preserve it privately; never commit it.

Create the external environment file below. It contains paths and test DIDs, not tokens. `RUN` must remain exported when invoking the desk's secrets tool.

```bash
cat > "$RUN/environment.sh" <<'SH'
export ALCHEMY_TELEMETRY_DISABLED=1
export RAT_KING_STATE_DIR="$RUN/state"
export RAT_KING_DOCUMENTS="$RUN/documents.json"
export RAT_KING_CF_IDENTITY_FILE="$RUN/hosted.json"
export RAT_KING_REMOTE_DID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).hosted.did)' "$RUN/inputs.json")"
export RAT_KING_SERVICE_DID="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).service.did)' "$RUN/inputs.json")"
export RAT_KING_VERSION=cf-preview-measure
export RAT_KING_COMMIT="$(< "$RUN/candidate")"
export RAT_KING_AGENT_MODEL=faux
SH
chmod 600 "$RUN/environment.sh"
source "$RUN/environment.sh"
```

Start with a clean environment. Unset every `MODEL_GATEWAY_*` variable, including empty ones, and any sidecar input. The stack refuses these inputs rather than silently ignoring them.

## Credential injection for networked stack steps

The desk injects these environment names using its secrets tool:

| Environment             | Secret reference             |
| ----------------------- | ---------------------------- |
| `CLOUDFLARE_API_TOKEN`  | `<deploy-token-secret-name>` |
| `CLOUDFLARE_ACCOUNT_ID` | `<account-secret-name>`      |

Never use `set -x`, echo a token, put one in argv or save it in the environment file. The network blocks below run **inside** that injected process, from the pinned checkout. For example, the desk's `secrets_exec` call for a networked plan is:

```json
{
  "env": {
    "CLOUDFLARE_API_TOKEN": "<deploy-token-secret-name>",
    "CLOUDFLARE_ACCOUNT_ID": "<account-secret-name>"
  },
  "command": [
    "bash",
    "-c",
    "source \"$RUN/environment.sh\"; export RAT_KING_CF_DEPLOY_APPROVED=true RAT_KING_CF_OFFLINE_PLAN=false; node stacks/cf/cli.ts plan"
  ],
  "timeout_seconds": 600
}
```

Set the tool's `cwd` to the pinned checkout. Supply `RUN` in the parent environment or replace `$RUN` with its concrete external path in the command. Inspect the actual plan, not merely the process exit code.

## 2. Offline plan, then networked plan

No credentials are needed for the offline attempt:

```bash
source "$RUN/environment.sh"
RAT_KING_CF_OFFLINE_PLAN=true RAT_KING_CF_DEPLOY_APPROVED=false \
  node stacks/cf/cli.ts plan > "$RUN/plan-offline.log" 2>&1
```

Expected limitation: the stock planner reads the Worker subdomain. The rejecting offline transport reports `OFFLINE_HTTP_REFUSED` and exits nonzero after graph construction. This is not a successful rendered plan. Stop for any different failure, including missing inputs or bundling errors.

After the desk obtains deployment approval, run this through credential injection:

```bash
source "$RUN/environment.sh"
export RAT_KING_CF_DEPLOY_APPROVED=true RAT_KING_CF_OFFLINE_PLAN=false
node stacks/cf/cli.ts plan > "$RUN/plan-networked.log" 2>&1
```

Review for exactly the preview Worker and the five DO classes: Mailbox, AuthTokens, Agent, Issuer and Desk. No domains, routes or gateway vars. Delete and replace actions remain refused. Do not proceed if the deterministic preview Worker belongs to another run.

## 3. Deploy and record the target

Through the same injected process:

```bash
source "$RUN/environment.sh"
export RAT_KING_CF_DEPLOY_APPROVED=true RAT_KING_CF_OFFLINE_PLAN=false
node stacks/cf/cli.ts deploy > "$RUN/deploy.log" 2>&1
```

Record the exact HTTPS workers.dev origin reported by the deployment as `BASE_URL`. Verify the deployed version and commit against `$RUN/candidate` using the existing health surface. Save the five namespace IDs from the deployed Worker bindings as a comma-separated `NAMESPACES`. Do not infer namespace IDs from class names. These are inputs to the analytics reader, not public inventory.

No missing Issuer or Desk input was found: both classes are exported by `hosted-worker.ts`, included in `hostedBindings`, and projected from the declaration. The old README class list was stale. Live Alchemy authentication, migration execution and runtime compatibility still require this desk-run deployment; passing projection tests does not prove them.

## 4. Run the bounded 24-hour measurement

No Cloudflare token is needed by the driver. Run it from a token-free shell. `BASE_URL` is an HTTP(S) origin without credentials, path, query or fragment. Choose a new output filename for every run; existing files are refused.

```bash
export BASE_URL='https://REPLACE_WITH_DEPLOYED_WORKER_ORIGIN'
nohup timeout --signal=TERM --kill-after=30s 24h \
  node tools/cf-measure/cli.ts drive \
  --directory "$RUN" --documents "$RUN/documents.json" \
  --base-url "$BASE_URL" --readers 6 --per-day 12000 --burst 1 \
  --seconds 86400 --drain-seconds 30 --output "$RUN/<deploy-host>.jsonl" \
  > "$RUN/<deploy-host>.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$RUN/<deploy-host>.pid"
```

The PID belongs to the `timeout` wrapper. The driver ends its workload at 24 hours, stops sending 30 seconds before that and drains receipts while readers remain connected. Scope exit releases leases. The outer deadline stops a stuck runtime; after TERM it allows at most 30 seconds before KILL. That fallback can lose the final summary, so a missing summary is a failed measurement, not zero errors. Save the exit status with the job runner if available. Never stop processes by name.

Readers use the production Pi consumer: 5-minute leases, renewals at half the remaining lifetime, scoped release, WebSocket watch and its real reconnect/fallback behavior. Lease, retry and skip records make that behavior visible. A reader failure stops the run and emits a summary. Reaching the deadline before every reader acquires its lease fails rather than reporting an empty success. Send failures are classified and do not stop the remaining workload. Sends are encrypted, quiet and rotate among the selected test readers; the hosted faux agent is deployed but does not receive this synthetic traffic. This isolates mailbox cost from hosted-agent replies.

For bursts, use `--burst 100 --per-day 12000`: 100 concurrent sends per batch at the same long-run rate. This does not mean 100 times the configured per-day traffic. Use a separate run and filename. A slow server limits achieved throughput; attempted and accepted counts report that instead of concealing it.

Inspect the result without printing message bodies or keys:

```bash
node -e 'const fs=require("node:fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); const last=rows.at(-1); if(last?.kind!=="summary") process.exit(1); console.log(JSON.stringify(last,null,2))' "$RUN/<deploy-host>.jsonl"
```

Timing definitions, in milliseconds from one driver's monotonic clock:

- Send: invocation of the encrypted send operation to the local accept response. This includes signing/encryption and HTTP transport, not just server execution.
- Delivery: local accept response to entry into the production consumer's handler, after verified open and the delivery receipt request. It is not raw socket-frame latency.
- Ack: ack request invocation to its response.

A recipient can enter the handler before the sender receives acceptance. Signed negative delivery observations are preserved and counted as `receiptBeforeAccept`; they are not clamped or silently dropped. This is a local observation bound, not a server-to-server timestamp claim. The driver records `attempt`, `accepted`, `received`, `acked`, final joined `message` timings, errors and a final summary. Percentiles use nearest rank. Missing phases stay incomplete and never become zero-latency samples. Error counters count operation failures; an ack failure can also end the reader and appear under reader failure. Keep the operation field when interpreting them.

The default load is spread over the test names. It is not a hosted-model benchmark and does not exercise issuer or desk APIs. The 30-second drain is a measurement choice, not a delivery SLO.

## 5. Ten-minute latency probe from `<probe-host>`

Use an approved private file transfer to copy the generated directory, including its mode-600 private inputs, to an external directory on the probe host. Keep keys out of command arguments and logs. Do not install a Cloudflare token there. Use the same checkout commit and deployed origin. Do not run readers with the same identities concurrently: finish the `<deploy-host>` run and confirm release first, or generate a separate test set and include its public documents in the preview before deployment.

Run from that host's checkout, with `RUN` set to its copied directory:

```bash
nohup timeout --signal=TERM --kill-after=30s 10m \
  node tools/cf-measure/cli.ts drive \
  --directory "$RUN" --documents "$RUN/documents.json" \
  --base-url "$BASE_URL" --readers 6 --per-day 12000 --burst 1 \
  --seconds 600 --drain-seconds 30 --output "$RUN/<probe-host>.jsonl" \
  > "$RUN/<probe-host>.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$RUN/<probe-host>.pid"
```

Use fresh identities for a new deployment/run, or retain the original JSONL and verify that old mail was acked before this sequential probe. The driver refuses foreign run payloads rather than acknowledging them.

For a celld baseline, use a **separate isolated test celld**, configured with the same service DID and public documents, never the fleet mailbox. Keep the same private inputs and every workload flag. Only `--base-url` and `--documents` change. The documents file must still contain exactly the matching test identities. Do not reuse active readers across endpoints. Save to a fresh output file and compare the same timing definitions, counts, errors and achieved rate. Provisioning or changing a celld is outside this harness.

## 6. Read analytics and estimate per-day cost

Use the exact summary `startedAt` and `finishedAt`, or a recorded <=24-hour UTC window. Do not include a second run in the same window. Analytics can lag. Query again into a new filename if data is incomplete; do not replace evidence. Empty datasets are retained as empty raw arrays, not proof that an endpoint had no usage.

The desk injects `CLOUDFLARE_ACCOUNT_ID` from `<account-secret-name>` and a separately scoped analytics-read token as `CLOUDFLARE_ANALYTICS_TOKEN`. This tool does not require or use the deployment token. The desk chooses its approved analytics secret reference; none is invented here.

Inside that injected process:

```bash
node tools/cf-measure/cli.ts cost \
  --worker rat-king-mailbox-preview --namespaces "$NAMESPACES" \
  --from "$FROM_UTC" --to "$TO_UTC" --duration-unit gb-seconds \
  --output "$RUN/cost.json"
```

The reader queries the Worker once per namespace but counts its usage only once. It queries DO invocations, periodic metrics and SQL storage for every supplied namespace. GraphQL errors, absent fields, invalid windows and a saturated result limit fail closed. Raw namespace results remain alongside the calculation, including Worker CPU/errors, DO errors, active time, CPU time, maximum active WebSocket connections and memory use.

Field names follow account schema introspection supplied by the desk on 2026-10-28. Units were not documented in that schema. **The desk must confirm that periodic `duration` is GB-seconds before passing `--duration-unit gb-seconds`.** Active-time and CPU-time units remain labelled unconfirmed. The reader groups invocations by `type`. It counts `fetch`, `rpc` and `alarm` as requests, excludes `websocket_message`, then adds incoming messages at 20:1. These constant type spellings must be checked in the first live window. Any unknown type fails with its sanitized name rather than being counted or ignored. Confirm its meaning and update the constant sets through review before retrying. Raw type breakdown stays in the output.

Hibernation evidence is indirect: compare active time/duration against the observation window while active WebSocket connections remain nonzero. After the main run releases its leases, keep an idle measurement with the same test readers:

```bash
node tools/cf-measure/cli.ts drive \
  --directory "$RUN" --documents "$RUN/documents.json" \
  --base-url "$BASE_URL" --readers 6 --per-day 0 \
  --seconds 600 --drain-seconds 30 --output "$RUN/idle.jsonl"
```

`--per-day 0` holds readers without sending. Query analytics for that separate window into a new file and confirm units before claiming hibernation. The load driver does not assert a platform lifecycle state from low latency or an open socket. No analytics metric alone here proves an individual object hibernated.

The constant rate table uses the requested Workers Paid rates. Sources: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). Included request, duration and row allowances are **monthly**, not per-day. The calculator extrapolates the measured workload to a standalone 30-day month, subtracts each included tier once, floors each meter at zero and divides by 30. Storage uses each namespace's peak bytes as a conservative constant occupancy estimate, decimal GB, at GB-month pricing. Incoming WS messages contribute one DO request per 20 messages; outgoing messages do not.

This is the per-day estimate for the listed meters, **not an invoice**. Existing account consumption can exhaust shared tiers. The estimate excludes the monthly base plan, Worker CPU, network charges, other services and taxes. Raw metrics and rates let the desk reconcile those separately. Do not claim a zero-cost production service from a zero incremental test estimate.

## 7. Destroy and prove teardown

Stop or await both driver PIDs first. Do not abandon teardown because measurement or analytics failed. Preserve private Alchemy state until the probe passes. Run each step through deployment-token/account injection with the same external inputs and pinned checkout:

```bash
source "$RUN/environment.sh"
export RAT_KING_CF_DEPLOY_APPROVED=true RAT_KING_CF_OFFLINE_PLAN=false
node stacks/cf/cli.ts destroy-plan > "$RUN/destroy-plan.log" 2>&1
```

Inspect the deletion plan and confirm it belongs to this preview. Then:

```bash
source "$RUN/environment.sh"
export RAT_KING_CF_DEPLOY_APPROVED=true RAT_KING_CF_OFFLINE_PLAN=false
node stacks/cf/cli.ts destroy > "$RUN/destroy.log" 2>&1
node stacks/cf/cli.ts teardown-probe > "$RUN/teardown.log" 2>&1
```

Require both `WORKER_ABSENT_PASS` and `NAMESPACES_ABSENT_PASS`, and a zero exit status. HTTP auth failure, a malformed reply or incomplete namespace pagination is not absence. If either check fails, retain state and ask the desk to resolve it. Do not delete state or broaden the probe's refusals to obtain green output.

Rollback for this experiment is the reviewed destroy plan, destroy and probe, not a production promotion. The desk owns every live step. Archive only redacted summaries and public-safe code receipts; keep private inputs, raw operational logs, account identifiers and Alchemy state outside the repository. Remove the transferred private test keys on both hosts after evidence is secured and teardown passes.

## Local checks

No live network is needed for unit tests. The cf project includes the measurement tests and the existing projection/teardown tests:

```bash
pnpm exec vitest run --project cf --maxWorkers=4
pnpm exec tsc --noEmit -p stacks/cf/tsconfig.json
muster-heavy -- pnpm check
muster-heavy -- pnpm test --maxWorkers=4
```

The tests prove timing arithmetic, fake reader deadline cleanup, classified errors, real local key generation/custody, strict fake analytics decoding, 20:1 WS conversion and monthly included-tier subtraction. They do not prove live Cloudflare units, GraphQL filter compatibility, hibernation or deployment. Those remain desk-run checks above.
