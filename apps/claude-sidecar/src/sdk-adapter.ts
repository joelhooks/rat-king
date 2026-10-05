/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- SDK and MCP callback boundaries. */
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off -- SDK/MCP handshake latches and the host session expiry are Promise boundaries.
// @effect-diagnostics nodeBuiltinImport:off -- Host-only SDK adapter owns its temporary working directory.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer } from "effect";
import { createToolServer } from "pi-claude-bridge/src/mcp-server.ts";
import {
  makePromptStream,
  userMessage,
} from "pi-claude-bridge/src/prompt-stream.ts";
import { createActor, createMachine } from "xstate";

import {
  MODEL,
  ModelDriver,
  requireModel,
  SidecarFailure,
  userText,
} from "./port.ts";
import type { ChatRequest, ToolCall, Turn } from "./port.ts";

const lifecycle = createMachine({
  initial: "running",
  states: {
    awaitingResult: {
      on: { CLOSE: { target: "closed" }, CONTINUE: { target: "running" } },
    },
    closed: { type: "final" },
    running: {
      on: {
        CLOSE: { target: "closed" },
        HANDOFF: { target: "awaitingResult" },
      },
    },
  },
});

export interface SdkGateway {
  readonly baseUrl: string;
  readonly apiKeyFile: string;
  readonly temporaryRoot?: string;
  readonly observeChild?: (names: readonly string[]) => void;
}

const shellQuote = (file: string) => `'${file.replaceAll("'", "'\\''")}'`;

interface McpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const tokenUsage = (usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}) => ({
  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
});

class Session {
  readonly state = createActor(lifecycle).start();
  readonly pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<McpResult>>
  >();
  readonly promptStream = makePromptStream();
  readonly awaiting = new Set<string>();
  output = Promise.withResolvers<Turn>();
  sdk: Query | undefined;
  child: ChildProcessWithoutNullStreams | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;

  readonly request: ChatRequest;
  readonly cwd: string;
  readonly executable: string;
  readonly gateway: SdkGateway & { readonly configDirectory: string };

  constructor(
    request: ChatRequest,
    cwd: string,
    executable: string,
    gateway: SdkGateway & { readonly configDirectory: string }
  ) {
    this.request = request;
    this.cwd = cwd;
    this.executable = executable;
    this.gateway = gateway;
  }

  close() {
    this.state.send({ type: "CLOSE" });
    clearTimeout(this.timeout);
    this.promptStream.fail(new Error("Sidecar closed"));
    this.sdk?.close();
    this.child?.kill("SIGTERM");

    for (const result of this.pending.values()) {
      result.resolve({
        content: [{ text: "Sidecar closed", type: "text" }],
        isError: true,
      });
    }

    this.pending.clear();
  }

  fail(cause: unknown) {
    this.output.reject(cause);
    this.close();
  }

  start() {
    const tools = this.request.tools ?? [];

    const server = createToolServer(
      "durable-tools",
      tools.map(({ function: tool }) => ({
        description: tool.description ?? "",
        handler: async (id) => {
          const result =
            this.pending.get(id) ?? Promise.withResolvers<McpResult>();

          this.pending.set(id, result);

          try {
            return await result.promise;
          } finally {
            this.pending.delete(id);
          }
        },
        inputSchema: tool.parameters,
        name: tool.name,
      }))
    );

    this.sdk = query({
      options: {
        allowedTools: tools.map(
          ({ function: tool }) => `mcp__durable-tools__${tool.name}`
        ),
        canUseTool: () =>
          Promise.resolve({
            behavior: "deny",
            message: "Only declared durable MCP tools are allowed",
          }),
        cwd: this.cwd,
        env: {
          ANTHROPIC_BASE_URL: this.gateway.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CONFIG_DIR: this.gateway.configDirectory,
          DISABLE_AUTOUPDATER: "1",
          DISABLE_AUTO_COMPACT: "1",
          ENABLE_CLAUDEAI_MCP_SERVERS: "0",
          HOME: this.gateway.configDirectory,
          PATH: "/usr/bin:/bin",
        },
        includePartialMessages: true,
        maxTurns: 8,
        mcpServers: { "durable-tools": server },
        model: MODEL,
        pathToClaudeCodeExecutable: this.executable,
        persistSession: false,
        settingSources: [],
        settings: {
          apiKeyHelper: `/bin/cat ${shellQuote(this.gateway.apiKeyFile)}`,
          autoMemoryEnabled: false,
          availableModels: [MODEL],
          claudeMdExcludes: ["**"],
          disableAllHooks: true,
          enforceAvailableModels: true,
          includeGitInstructions: false,
        },
        skills: [],
        spawnClaudeCodeProcess: (options) => {
          this.gateway.observeChild?.(Object.keys(options.env));

          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"],
          });

          this.child = child;

          return child;
        },
        strictMcpConfig: true,
        systemPrompt: {
          append: this.request.messages
            .filter(
              (message) =>
                message.role === "system" || message.role === "developer"
            )
            .map((message) => message.content ?? "")
            .join("\n"),
          preset: "claude_code",
          type: "preset",
        },
        tools: [],
      },
      prompt: this.promptStream.stream,
    });
    void this.promptStream
      .push(userMessage(userText(this.request)))
      .catch((error: unknown) => {
        this.fail(error);
      });
    this.timeout = setTimeout(() => {
      this.fail(new Error("Sidecar turn expired after 120 seconds"));
    }, 120_000);
    void this.consume(this.sdk).catch((error: unknown) => {
      this.fail(error);
    });

    return this.output.promise;
  }

  validateInitialization(model: string, tools: readonly string[]) {
    if (
      model !== MODEL ||
      tools.some(
        (tool) =>
          !(this.request.tools ?? []).some(
            ({ function: declared }) =>
              tool === `mcp__durable-tools__${declared.name}`
          )
      )
    ) {
      throw new Error(
        "Claude Code initialized with an unexpected model or host tool"
      );
    }
  }

  async consume(sdk: Query) {
    for await (const message of sdk) {
      if (message.type === "system" && message.subtype === "init") {
        this.validateInitialization(message.model, message.tools);
      }

      if (message.type === "assistant") {
        if (message.message.model !== MODEL) {
          throw new Error("Claude Code assistant returned an unexpected model");
        }

        if (message.error !== undefined) {
          throw new Error(`Claude Code assistant failed: ${message.error}`);
        }

        let text = "";
        const calls: ToolCall[] = [];

        for (const block of message.message.content) {
          if (block.type === "text") {
            text += block.text;
          }

          if (block.type === "tool_use") {
            const tool = this.request.tools?.find(
              ({ function: declared }) =>
                block.name === `mcp__durable-tools__${declared.name}`
            );

            if (!tool) {
              throw new Error(`Unserved tool call: ${block.name}`);
            }

            calls.push({
              function: {
                arguments: JSON.stringify(block.input),
                name: tool.function.name,
              },
              id: block.id,
              type: "function",
            });
            this.awaiting.add(block.id);

            if (!this.pending.has(block.id)) {
              this.pending.set(block.id, Promise.withResolvers<McpResult>());
            }
          }
        }

        if (calls.length > 0) {
          this.state.send({ type: "HANDOFF" });
          this.output.resolve({
            calls,
            claudePid: this.child?.pid,
            ...tokenUsage(message.message.usage),
            text,
          });
        }
      }

      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
          throw new Error(`Claude Code failed: ${message.subtype}`);
        }

        this.output.resolve({
          calls: [],
          claudePid: this.child?.pid,
          ...tokenUsage(message.usage),
          text: message.result,
        });
        this.close();
      }
    }

    if (!this.state.getSnapshot().matches("closed")) {
      this.fail(new Error("Claude Code ended without a result"));
    }
  }

  continue(request: ChatRequest) {
    if (!this.state.getSnapshot().matches("awaitingResult")) {
      throw new Error("Session is not awaiting tool results");
    }

    const results = request.messages.filter(
      (message) => message.role === "tool"
    );

    const ids = [...this.awaiting];

    if (
      ids.length === 0 ||
      ids.some(
        (id) =>
          results.filter((result) => result.tool_call_id === id).length !== 1
      )
    ) {
      throw new Error("Missing or duplicate durable tool results");
    }

    this.output = Promise.withResolvers<Turn>();
    this.state.send({ type: "CONTINUE" });

    for (const id of ids) {
      const result = results.find((message) => message.tool_call_id === id);
      this.pending
        .get(id)
        ?.resolve({ content: [{ text: result?.content ?? "", type: "text" }] });
      this.awaiting.delete(id);
    }

    return this.output.promise;
  }
}

export const sdkLayer = (executable: string, gateway: SdkGateway) =>
  Layer.effect(
    ModelDriver,
    Effect.gen(function* makeDriver() {
      const sessions = new Set<Session>();

      const temporaryRoot = gateway.temporaryRoot ?? tmpdir();
      yield* Effect.tryPromise({
        catch: () =>
          new SidecarFailure({ reason: "Cannot create private temp root" }),
        try: () => mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
      });

      const cwd = yield* Effect.tryPromise({
        catch: (cause) => new SidecarFailure({ reason: String(cause) }),
        try: () => mkdtemp(path.join(temporaryRoot, "rat-king-claude-cwd-")),
      });

      const configDirectory = yield* Effect.tryPromise({
        catch: (cause) => new SidecarFailure({ reason: String(cause) }),
        try: () => mkdtemp(path.join(temporaryRoot, "rat-king-claude-config-")),
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* closeDriver() {
          yield* Effect.sync(() => {
            for (const session of sessions) {
              session.close();
            }
          });
          yield* Effect.tryPromise({
            catch: () =>
              new SidecarFailure({ reason: "Private temp cleanup failed" }),
            try: async () => {
              await rm(configDirectory, { force: true, recursive: true });
              await rm(cwd, { force: true, recursive: true });
            },
          }).pipe(Effect.orDie);
        })
      );

      const turn = Effect.fn("ClaudeSdk.turn")(function* turn(
        request: ChatRequest
      ) {
        yield* requireModel(request.model);

        return yield* Effect.tryPromise({
          catch: (cause) => new SidecarFailure({ reason: String(cause) }),
          try: async () => {
            const last = request.messages.at(-1);

            if (last?.role === "tool") {
              const session = [...sessions].find(
                (candidate) =>
                  last.tool_call_id !== undefined &&
                  candidate.pending.has(last.tool_call_id)
              );

              if (!session) {
                throw new Error(
                  "Tool result has no live sidecar session; restart replay is not supported"
                );
              }

              return await session.continue(request);
            }

            if (
              request.messages.some(
                (message) =>
                  message.role === "assistant" || message.role === "tool"
              )
            ) {
              throw new Error(
                "Importing prior sidecar history is not supported"
              );
            }

            const session = new Session(request, cwd, executable, {
              ...gateway,
              configDirectory,
            });

            sessions.add(session);
            session.state.subscribe({
              complete: () => {
                sessions.delete(session);
              },
            });

            return await session.start();
          },
        });
      });

      return ModelDriver.of({ turn });
    })
  );
