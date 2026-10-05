/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Loopback HTTP capture and SDK process qualification. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Real-client, dummy-key HTTP boundary property.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { expect } from "vitest";

import { MODEL, ModelDriver } from "../src/port.ts";
import { sdkLayer } from "../src/sdk-adapter.ts";
import { serve } from "../src/server.ts";

const executable = process.env.RAT_KING_CLAUDE_EXECUTABLE;

const token = "dummy-policy-bearer-not-a-real-secret";

const aliases = ["opus", "sonnet", "claude-sonnet-5", "default", "reset"];

const whitespace = [
  "",
  " ",
  "\t",
  "\n",
  "\u00A0",
  "\u2003",
  "\u3000",
  "\uFEFF",
];

const Sample = Schema.Struct({
  leading: Schema.Array(Schema.Literals(whitespace)).check(
    Schema.isMaxLength(5)
  ),
  messages: Schema.Array(
    Schema.Struct({
      content: Schema.String.check(Schema.isMaxLength(24)),
      role: Schema.Literals(["system", "developer", "user"]),
    })
  ).check(Schema.isMaxLength(4)),
  responseModel: Schema.String.check(Schema.isMaxLength(40)),
});

const Captured = Schema.Struct({ model: Schema.String });

const user = (content: string): (typeof Sample.Type.messages)[number] => ({
  content,
  role: "user",
});

const listen = (server: Server) =>
  Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || Schema.is(Schema.String)(address)) {
        resume(Effect.die("Missing loopback port"));
      } else {
        resume(Effect.succeed(address.port));
      }
    });
  });

it.live.prop(
  "command-form user lists never launch; gateway requests and replies enforce the exact model",
  [Arbitrary.schema(Sample)],
  ([sample]) =>
    Effect.gen(function* policy() {
      if (executable === undefined) {
        return;
      }

      const directory = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "rat-king-policy-"))
      );

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(directory, { force: true, recursive: true }))
      );
      const apiKeyFile = path.join(directory, "dummy'key");
      yield* Effect.promise(() =>
        writeFile(apiKeyFile, "dummy-loopback-key", { mode: 0o600 })
      );
      const captured: string[] = [];
      let responseModel = MODEL;
      let launches = 0;

      const handle = async (
        request: IncomingMessage,
        response: ServerResponse
      ) => {
        if (request.url?.startsWith("/v1/messages") !== true) {
          response.writeHead(404).end();

          return;
        }

        const chunks: string[] = [];

        for await (const chunk of request) {
          chunks.push(String(chunk));
        }

        const input: unknown = JSON.parse(chunks.join(""));
        captured.push(Schema.decodeUnknownSync(Captured)(input).model);
        response.writeHead(200, { "content-type": "text/event-stream" });

        const events = [
          {
            message: {
              content: [],
              id: "msg_dummy",
              model: responseModel,
              role: "assistant",
              stop_reason: null,
              stop_sequence: null,
              type: "message",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
            type: "message_start",
          },
          {
            content_block: { text: "", type: "text" },
            index: 0,
            type: "content_block_start",
          },
          {
            delta: { text: "dummy answer", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
          { index: 0, type: "content_block_stop" },
          {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            type: "message_delta",
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];

        for (const event of events) {
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          );
        }

        response.end();
      };

      const gateway = createServer((request, response) => {
        void handle(request, response);
      });

      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          gateway.closeAllConnections();
          gateway.close(() => {
            resume(Effect.succeed(true));
          });
        })
      );
      const port = yield* listen(gateway);

      const sidecar = yield* serve(token, executable, {
        apiKeyFile,
        baseUrl: `http://127.0.0.1:${port}`,
        observeChild: () => {
          launches += 1;
        },
        temporaryRoot: directory,
      });

      const post = (messages: typeof Sample.Type.messages, model = MODEL) =>
        Effect.gen(function* postChat() {
          const request = yield* HttpClientRequest.post(
            `${sidecar.baseUrl}/v1/chat/completions`,
            {
              headers: { authorization: `Bearer ${token}` },
            }
          ).pipe(HttpClientRequest.bodyJson({ messages, model, stream: true }));

          const response = yield* HttpClient.execute(request);

          return { body: yield* response.text, status: response.status };
        }).pipe(Effect.provide(FetchHttpClient.layer));

      const nonUser = sample.messages.filter(
        (message) => message.role !== "user"
      );

      for (const leading of [sample.leading.join(""), ...whitespace]) {
        for (const alias of aliases) {
          const command = `/model ${alias}`;

          for (const messages of [
            [...nonUser, user(leading + command), ...sample.messages],
            [...nonUser, user(leading), user(command), ...sample.messages],
            [user("Earlier text"), user(leading + command)],
          ]) {
            expect((yield* post(messages)).status).toBe(400);
          }
        }
      }

      for (const alias of aliases) {
        expect(
          (yield* post([{ content: "Reply hi", role: "user" }], alias)).status
        ).toBe(400);
      }

      expect(launches).toBe(0);
      expect(captured).toEqual([]);

      const safe = [
        user("Reply hi"),
        ...sample.messages.map((message) => ({
          ...message,
          content: `Data: ${message.content}`,
        })),
      ];

      const allowed = yield* post(safe);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toContain("dummy answer");

      for (const forbidden of [
        "claude-sonnet-5",
        `${sample.responseModel}-not-allowed`,
      ]) {
        responseModel = forbidden;
        const refused = yield* post(safe);
        expect(refused.status).toBe(400);
        expect(refused.body).not.toContain("dummy answer");
      }

      expect(captured.length).toBeGreaterThanOrEqual(3);
      const beforeCommand = captured.length;
      responseModel = MODEL;
      yield* Effect.gen(function* directCommand() {
        const driver = yield* ModelDriver;
        yield* driver
          .turn({
            messages: [{ content: "/model claude-sonnet-5", role: "user" }],
            model: MODEL,
            stream: true,
          })
          .pipe(Effect.ignore);
      }).pipe(
        Effect.provide(
          sdkLayer(executable, {
            apiKeyFile,
            baseUrl: `http://127.0.0.1:${port}`,
            temporaryRoot: directory,
          })
        )
      );
      expect(captured).toHaveLength(beforeCommand);
      expect(captured.every((model) => model === MODEL)).toBe(true);
    }).pipe(Effect.scoped),
  {
    arbitrary: { maxShrinks: 5, runs: 5 },
    skip: executable === undefined,
    timeout: 180_000,
  }
);
