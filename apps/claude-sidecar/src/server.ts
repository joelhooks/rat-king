/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Node HTTP callbacks and SDK transport. */
// @effect-diagnostics nodeBuiltinImport:off -- Loopback-only host HTTP endpoint.
// @effect-diagnostics asyncFunction:off globalDate:off -- Node HTTP boundary and OpenAI transport timestamp.
import { Buffer } from "node:buffer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Effect, ManagedRuntime, Schema } from "effect";

import { logHttpFailure } from "./diagnostics.ts";
import {
  ChatRequest,
  MODEL,
  ModelDriver,
  requireModel,
  SidecarFailure,
  userText,
} from "./port.ts";
import { sdkLayer } from "./sdk-adapter.ts";
import type { SdkGateway } from "./sdk-adapter.ts";

export const serve = (
  token: string,
  executable: string,
  gateway: SdkGateway,
  configuredPort = 0
) =>
  Effect.gen(function* serveSidecar() {
    if (Buffer.byteLength(token, "utf-8") < 32) {
      return yield* new SidecarFailure({
        reason: "Bearer token must have at least 32 bytes",
      });
    }

    const runtime = ManagedRuntime.make(sdkLayer(executable, gateway));
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));

    const usage: {
      inputTokens: number;
      outputTokens: number;
      claudePid: number | undefined;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }[] = [];

    const handle = async (
      request: IncomingMessage,
      response: ServerResponse
    ) => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);

      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        logHttpFailure(
          401,
          "policy_refusal",
          new Error("Authorization refused")
        );
        response.writeHead(401).end();

        return;
      }

      if (request.method === "GET" && request.url === "/metrics") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ rssBytes: process.memoryUsage().rss, usage }));

        return;
      }

      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        logHttpFailure(404, "policy_refusal", new Error("Route not found"));
        response.writeHead(404).end();

        return;
      }

      let failureKind = "stream_error";

      try {
        const chunks: Buffer[] = [];
        let size = 0;

        for await (const chunk of request) {
          const bytes = Schema.decodeUnknownSync(Schema.instanceOf(Buffer))(
            chunk
          );

          size += bytes.length;

          if (size > 1_048_576) {
            throw new Error("Request exceeds 1 MiB");
          }

          chunks.push(bytes);
        }

        failureKind = "policy_refusal";
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const chat = Schema.decodeUnknownSync(ChatRequest)(input);

        if (
          userText(chat)
            .replace(/^[\s\p{Cf}]*/u, "")
            .startsWith("/") ||
          chat.messages.some(
            (message) =>
              message.role === "user" &&
              (message.content ?? "")
                .replace(/^[\s\p{Cf}]*/u, "")
                .startsWith("/")
          )
        ) {
          throw new Error("Command-form user text is not accepted");
        }

        failureKind = "model_error";
        await runtime.runPromise(requireModel(chat.model));

        failureKind = "sdk_error";

        const turn = await runtime.runPromise(
          Effect.gen(function* turnRequest() {
            return yield* (yield* ModelDriver).turn(chat);
          })
        );

        usage.push({
          cacheReadTokens: turn.cacheReadTokens,
          cacheWriteTokens: turn.cacheWriteTokens,
          claudePid: turn.claudePid,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
        });
        const id = `chatcmpl-${randomUUID()}`;

        const common = {
          created: Math.floor(Date.now() / 1000),
          id,
          model: MODEL,
          object: "chat.completion.chunk",
        };

        failureKind = "stream_error";
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        });
        response.write(
          `data: ${JSON.stringify({ ...common, choices: [{ delta: { content: turn.text, role: "assistant", tool_calls: turn.calls.map((call, index) => ({ ...call, index })) }, finish_reason: null, index: 0 }] })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({ ...common, choices: [{ delta: {}, finish_reason: turn.calls.length > 0 ? "tool_calls" : "stop", index: 0 }], usage: { completion_tokens: turn.outputTokens, prompt_tokens: turn.inputTokens, total_tokens: turn.inputTokens + turn.outputTokens } })}\n\n`
        );
        response.end("data: [DONE]\n\n");
      } catch (error) {
        logHttpFailure(400, failureKind, error);

        if (response.headersSent) {
          response.destroy();

          return;
        }

        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message:
                "Sidecar rejected request or Claude Code failed; inspect local proof evidence",
              type: "sidecar_failure",
            },
          })
        );
      }
    };

    const server = createServer((request, response) => {
      void handle(request, response);
    });

    yield* Effect.addFinalizer(() =>
      Effect.callback<boolean>((resume) => {
        server.closeAllConnections();
        server.close(() => {
          resume(Effect.succeed(true));
        });
      })
    );

    const port = yield* Effect.callback<number, SidecarFailure>((resume) => {
      server.once("error", (cause) => {
        resume(Effect.fail(new SidecarFailure({ reason: String(cause) })));
      });
      server.listen(configuredPort, "127.0.0.1", () => {
        const address = server.address();

        if (address === null || Schema.is(Schema.String)(address)) {
          resume(
            Effect.fail(
              new SidecarFailure({ reason: "Missing ephemeral loopback port" })
            )
          );
        } else {
          resume(Effect.succeed(address.port));
        }
      });
    });

    return { baseUrl: `http://127.0.0.1:${port}` };
  });
