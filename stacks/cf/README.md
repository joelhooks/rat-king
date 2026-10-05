# Cloudflare preview target

Code-ready only. This is a second deployment target for the shared hosted mailbox declaration in `apps/mailbox/src/bindings.ts`. Nest and Cloudflare call the same `prepareDeployment` builder against `hosted-worker.ts`. Separate stacks keep provider graphs, lifecycle and state independent; a target switch in the host graph would mix unrelated infrastructure.

The stack is `cf`, stage `preview`. Its deterministic Worker name is `rat-king-mailbox-preview`. It uses stock Alchemy `Cloudflare.Worker` and `Cloudflare.DurableObject`. No deployment or continuous delivery is enabled by this code.

## Inputs

Run from the repository with private inputs outside it:

- `ALCHEMY_TELEMETRY_DISABLED=1`, required for every action.
- `RAT_KING_STATE_DIR`, required external state directory. The launcher refuses paths inside the repository, including symlink targets.
- `RAT_KING_DOCUMENTS`, external public DID-document JSON file.
- `RAT_KING_REMOTE_DID`, hosted agent DID.
- `RAT_KING_SERVICE_DID`, mailbox service DID.
- `RAT_KING_VERSION` and `RAT_KING_COMMIT`, required bundle identity.
- `RAT_KING_CF_IDENTITY_FILE`, external mode-600 JSON file containing one identity with `did`, `agreement` and `signing`. Each key contains `crv: "P-256"`, `kty: "EC"`, `x`, `y` and private `d`. Its DID must match the hosted DID.
- `CLOUDFLARE_ACCOUNT_ID` and Alchemy’s standard Cloudflare API-token environment input. Alchemy owns credential resolution; the launcher passes the environment through without reading or printing credentials. The teardown probe obtains resolved token credentials from Alchemy. See [Alchemy authentication providers](https://alchemy.run/environments/auth-providers).
- `RAT_KING_CF_OFFLINE_PLAN`, defaults to `true`. The offline HTTP transport rejects every request without opening a network connection.
- `RAT_KING_CF_DEPLOY_APPROVED=true`, required for any network-enabled action or mutation. This switch records explicit approval; it does not grant approval itself.

The identity is encoded as a one-element array, matching Nest runtime bindings, and passed as `Redacted<string>` in `AGENT_IDENTITIES_CREDENTIAL`. Alchemy classifies it as `secret_text`. It is never a generated public var. Alchemy state belongs in the external private directory, not the public Git tree. Retain and secure that state after a failed probe.

Only faux mode is permitted. Omit `RAT_KING_AGENT_MODEL` or set it to `faux`. Any `MODEL_GATEWAY_*` input, including an empty value, is refused. Gateway mode and the Claude sidecar are refused. Generated preview vars contain no gateway origin.

## Actions

```sh
node stacks/cf/cli.ts plan
node stacks/cf/cli.ts deploy
node stacks/cf/cli.ts destroy-plan
node stacks/cf/cli.ts destroy
node stacks/cf/cli.ts teardown-probe
```

- `plan` evaluates the real resource graph, then calls Alchemy's stock planner. Delete and replace actions are refused.
- `deploy` requires approval and `RAT_KING_CF_OFFLINE_PLAN=false`.
- `destroy-plan` describes the graph to delete. Offline mode makes no network calls; network-enabled planning requires approval.
- `destroy` requires approval and offline mode disabled. Inspect the destroy plan first.
- `teardown-probe` requires approval and offline mode disabled. It makes GET requests only, checking the script's settings and every page of account Durable Object namespaces. Only the specific script-not-found response proves script absence. Authentication errors, malformed responses and incomplete pagination never pass. Pagination stops on a short page (fewer than 100 entries) or a validated `total_pages` boundary when supplied, with a hard 1000-page cap. Missing `total_pages` is allowed; malformed metadata fails closed. Output uses pass/fail labels with sanitised HTTP status, error codes or schema/step names on failure, never response bodies or identifiers. A namespace failure preserves a proven worker PASS; failure exits nonzero.

For the later live phase, set both approval and offline inputs explicitly, use fresh external state and private files, inspect `plan`, deploy, prove the recipient behavior, inspect `destroy-plan`, destroy, then run the probe. No live action has been qualified.

## Projection and source evidence

Installed Alchemy `2.0.0-beta.80` is authoritative, not the beta.79 documentation mirror. The installed Worker source has expanded environment binding typing and updated Effect HTTP imports compared with that mirror.

`WorkerProps.script` bypasses bundling. `WorkerProvider` places that string directly in the uploaded `main.js` module. The projection passes the exact `prepareDeployment.bundle` string, without rebuilding. `bundle: false` preserves explicitly declared compatibility flags instead of appending Alchemy defaults.

Every DO binding keeps its declaration name and exported class name. Alchemy drives Cloudflare migration tags itself, beginning at `alchemy:v1`; celld receives the declaration's `v1` migration. Both use the same class set: Mailbox, AuthTokens and Agent.

The Worker has `workersDev: { enabled: true, previewsEnabled: false }`. The projection cannot emit `domain` or `routes`. This is an ordinary Worker in a stage named preview, not Alchemy's `preview.of` or version-rollout mode.

## Proven and not tested

Proven locally:

- Effect Arbitrary / `@effect/vitest` properties preserve every generated valid declaration's bindings, classes, vars, flags and bundle text, without extra surfaces.
- A generated property compares serialized Nest configuration against the pre-refactor inline construction across vars, version, commit and model inputs. No redundant pinned example is needed.
- Generated fake HTTP properties check teardown absence, pagination and refusal to mistake HTTP failures for absence.
- A real offline invocation builds the hosted bundle and evaluates the stock Worker resource graph. The stock planner then requires a live read of the Worker subdomain. The rejecting transport produces `OFFLINE_HTTP_REFUSED`; no rendered action plan is claimed.

Not tested: live account authentication, script upload, platform runtime compatibility, workers.dev readback, secret custody on Cloudflare, migration execution, encrypted recipient behavior, no-change live plan, live destroy or live teardown. Offline graph construction is not deployment proof.
