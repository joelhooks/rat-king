# Claude model sidecar

A Node process turns a real Claude Code client into a loopback-only OpenAI chat-completions endpoint. pi-durable owns tool execution inside the celld Durable Object. The sidecar only hands declared tool calls out and passes their results back to the waiting Claude Code query.

Only `claude-opus-5-5` is allowed. Other request IDs fail before SDK startup. The HTTP boundary rejects user messages starting with `/` after leading whitespace, both individually and after joining, before invoking the driver. Inline `availableModels: [MODEL]` and `enforceAvailableModels: true` also constrain the CLI's model selection. Sol and Luna keep their model-gateway route; the default remains `gpt-6-sol`.

## Boundaries

`src/port.ts` owns the decoded request, typed failures and `ModelDriver` service. `src/sdk-adapter.ts` supplies its scoped Effect Layer. XState models `running → awaitingResult → running → closed`. An SDK query stays alive across the HTTP tool-call handoff. The next HTTP request must carry exactly one result for each pending call ID. Missing sessions fail closed; there is no disk-session replay.

The HTTP endpoint emits OpenAI SSE chunks at completed tool/answer boundaries, not token-by-token deltas. It accepts text-only, streaming requests. This POC supports a fresh user turn and its live tool continuations, not arbitrary imported chat history.

Claude Code receives `tools: []`. Only the request's declared MCP names are allowed; the permission callback denies everything else. Initialization rejects unexpected model IDs or tool names. Every assistant message's reported model is checked before consuming content or handing off tools. A mismatched reply fails the HTTP request rather than being relabelled as Opus. The MCP handlers never run model tools on the host: they wait for the DO's results. The credential helper is the one deliberate exception to host command execution: Claude Code runs `/bin/cat` against the configured credential file for authentication. Its path is shell-quoted, and neither its path nor its contents are committed.

The launcher accepts bearer and gateway-key files only as nonempty regular files owned by its uid, with permissions 600 or tighter and no execute or special bits. It walks every parent directory with no-follow descriptors, rejects writable-by-others or foreign-owned directories (except root-owned ancestors), and rejects symlinks anywhere in the path. File metadata and contents come from the same opened descriptor; nonblocking open prevents FIFO hangs. The helper reads a mode-600 snapshot in an owned mode-700 directory, not a later replacement of the gateway binding. Scoped shutdown removes the snapshot. Configured bearers must contain at least 32 UTF-8 bytes; proof bearers use 32 cryptographically random bytes encoded as hex.

Each HTTP route, including metrics, requires the per-instance bearer. The listener always binds `127.0.0.1`. Port `0` selects an ephemeral proof port; deployment must configure a fixed port. There is no public listener or remote fallback.

## Client isolation and authentication

The launcher requires an explicit dedicated executable through `RAT_KING_CLAUDE_EXECUTABLE`. Install it separately under the user's `~/.local/share/rat-king/`, not the user's ordinary Claude launcher. The SDK uses `pathToClaudeCodeExecutable`; it does not vendor the client or run an installer.

The child environment is built from scratch. `HOME` and `CLAUDE_CONFIG_DIR` point at a fresh mode-700 temp directory, and `PATH` is `/usr/bin:/bin`. No parent credentials, user settings, hooks, memory, plugins or login are inherited. `settingSources: []`, `skills: []`, `strictMcpConfig: true`, `disableAllHooks: true`, `autoMemoryEnabled: false`, `claudeMdExcludes: ["**"]` and `persistSession: false` enforce the isolated query shape. The layer removes only its own config and working directories on disposal with Node filesystem APIs; it needs no external cleanup CLI. `RAT_KING_SIDECAR_TEMP_DIR` selects the parent directory (default `/tmp`).

`DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disable updates and nonessential traffic. `ENABLE_CLAUDEAI_MCP_SERVERS=0` excludes account-connected MCP servers. `DISABLE_AUTO_COMPACT=1` leaves compaction to the durable caller.

The gateway endpoint file contains the OpenAI `/v1` URL. The launcher strips that suffix for Claude Code's gateway origin. It requires HTTPS except for numeric loopback proof endpoints: IPv4 `127.0.0.0/8` and IPv6 `::1`. Every DNS hostname requires HTTPS. It rejects URL credentials, queries and fragments. Inline `settings.apiKeyHelper` reads the mode-600 gateway credential file. The SDK uses Claude Code's genuine `claude_code` system-prompt preset and only appends caller instructions. No extra client headers or fabricated identity are added. A deployment needs its own authorized gateway credential; it does not use a host user's Claude login.

The SDK source confirms this wiring: `sdk.mjs` line 121 forwards inline settings independently of `--setting-sources`, and line 221 copies an explicitly supplied environment instead of inheriting the parent. `sdk.d.ts` exposes `Settings.apiKeyHelper`. The retired dummy capture proof checked the installed client's helper behavior without contacting a model provider.

## Dependencies

- `@anthropic-ai/claude-agent-sdk` **0.3.268**, exact. Its `LICENSE.md` says © Anthropic PBC, all rights reserved, subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). It is not MIT.
- Claude Code **2.1.285**, installed independently and checksum-verified. Never bundled.
- `pi-claude-bridge` pinned to commit **1dff6271f067dcf4606e8c4405264a5182164e04** in `joelhooks/pi-claude-bridge`, MIT, Eli Dickinson. The sidecar imports its `src/mcp-server.ts` and `src/prompt-stream.ts`; there is no runtime dependency on its extension entry point.

The bridge's `convert.ts` imports `skills.ts`, which imports pi-coding-agent at runtime. We do not import that module: this endpoint decodes OpenAI text directly and retains live queries for tool results. Peer packages may be installed, but the Node bundle has no contributing pi-coding-agent or pi-tui modules. The bridge has source-only exports with incompatible strict TypeScript checks in `extract-tool-results.ts`; `types/` projects the two consumed module signatures without weakening this project's gates. esbuild uses its runtime source, not those declarations.

## Configuration

| Variable | Meaning |
| --- | --- |
| `RAT_KING_CLAUDE_EXECUTABLE` | Explicit dedicated Claude Code binary |
| `RAT_KING_SIDECAR_TOKEN_FILE` | Owned private bearer file, at least 32 bytes |
| `RAT_KING_SIDECAR_PORT` | Fixed deployment port; default 0 for local proof |
| `RAT_KING_SIDECAR_TEMP_DIR` | Parent for private config/working directories; default `/tmp` |
| `RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE` | Private gateway endpoint file |
| `RAT_KING_MODEL_GATEWAY_KEY_FILE` | Owned private gateway credential file |

The agent-runtime Layer selects Opus with `MODEL_GATEWAY_MODEL=claude-opus-5-5`, `CLAUDE_SIDECAR_BASE_URL=http://127.0.0.1:<configured-port>/v1` and secret binding `CLAUDE_SIDECAR_CREDENTIAL`. It rejects non-loopback sidecar URLs. Sol and Luna continue using `MODEL_GATEWAY_BASE_URL` and `MODEL_GATEWAY_CREDENTIAL`. Missing sidecar bindings never fall back to direct Anthropic requests.

## Checks

Default `pnpm test` runs the retained local suites without model usage. They cover model refusal, private-file boundaries, gateway URL admission and HTTP error redaction.

The celld real-model suite, dedicated-client policy probe and dummy SDK helper capture probe were retired. No current runner reproduces those qualifications. The earlier results remain recorded in [Local proof receipt](#local-proof-receipt); they are not current live qualification.

## Linux deployment code, not live-qualified

Install **2.1.285** in user scope without global npm or sudo. The exact glibc linux-x64 binary is:

`https://downloads.claude.ai/claude-code-releases/2.1.285/linux-x64/claude`

Checksum source: `https://downloads.claude.ai/claude-code-releases/2.1.285/manifest.json`, `platforms["linux-x64"].checksum`.

Verified manifest SHA-256: `33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29`.

Download to a new temp file, compare that checksum, then install mode 755 at `~/.local/share/rat-king/claude-code/2.1.285/claude`. Refuse to overwrite an existing installation until its version and checksum are checked. Do not run the general installer: it manages the user's normal launcher. The macOS proof uses the separate darwin-arm64 download, whose manifest SHA-256 is `51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4`.

`stacks/nest` and `packages/alchemy-nest/src/agent-runtime-files.ts` now own the optional sidecar unit, dedicated install and private files. Alchemy stores references, not gateway keys or bearer values. Build the fully bundled `sidecar.mjs` with `node apps/claude-sidecar/src/build.ts`, using `RAT_KING_SIDECAR_OUTPUT`. Example user-unit shape, not an installed unit:

```ini
[Unit]
Description=Rat King Claude model endpoint

[Service]
Type=simple
Slice=rat-king.slice
EnvironmentFile=%h/.local/share/rat-king/claude-sidecar/service.env
ExecStart=/usr/local/bin/node %h/.local/share/rat-king/claude-sidecar/sidecar.mjs
MemoryMax=1536M
CPUQuota=100%
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillMode=control-group
NoNewPrivileges=true
LimitCORE=0
UMask=0077

[Install]
WantedBy=default.target
```

The environment file selects port 18789, the dedicated executable, binding paths and a temp parent under the owned sidecar directory. No `trash` CLI is required. Every invocation still passes the exact SDK line `tools: [],` in `src/sdk-adapter.ts`; the hosted agent has no declared MCP tools either. The sidecar's 1536 MiB and 100% limits require an owner-approved budget alongside the other services. The nest stack accepts a separately approved parent slice cap; it does not raise the default 4 GiB cap silently. Linux cgroup kill semantics cover children too. No slice exists on macOS; the proof owns and stops exact PIDs instead.

Destroy must stop and disable the owned unit, remove its unit file, dedicated installation, private config, generated binding and bearer, and trash any owned temporary config directories. It must not touch the user's ordinary Claude installation or config. These install, deploy and destroy operations require the owning infrastructure lane's authorization. Code readiness does not establish live Linux behavior.

## Local proof receipt

The final helper-auth run passed in **13.64 seconds** through the actual agent-runtime sidecar Layer. The DO retained exactly one `add(2,3)` call, its non-error result `5`, the final assistant answer `5` and a `done` submission. Sidecar RSS was **107,280 KiB**. SDK cumulative usage was **4 uncached input, 1,806 cache-read, 1,912 cache-write and 79 output tokens**. Owned sidecar, celld and Claude child PIDs exited; the harness bearer files were removed. No deployment was performed.

Earlier, the first live fixture failed because it used the wrong pi-durable tool-argument signature; the corrected shared fixture passed. After removing inherited credential environment, the local dummy helper probe caught the client’s unauthenticated `/api/hello` preflight. Returning 404 for that unsupported probe and waiting for the authenticated model request qualified the final helper path without model spend.

## Not tested

Linux deployment, cgroup limits, host crash-collector behavior (including whether `LimitCORE=0` prevents credential persistence for Node and its children), fixed-port deployment, remote hosts, arbitrary conversation import, images, concurrent clients, cancellation at every instruction boundary, crashes during a sidecar handoff, durable sidecar-session recovery, sustained load, credential rotation, or gateway failure recovery. The live proof covers an uninterrupted local turn and one durable tool round trip, not exactly-once external model calls.
