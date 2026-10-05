/* oxlint-disable typescript/promise-function-async -- Node capture server and SDK callbacks. */
// @effect-diagnostics nodeBuiltinImport:off -- Zero-spend local credential-helper qualification.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect, vi } from "vitest";

import { MODEL, ModelDriver } from "../src/port.ts";
import { sdkLayer } from "../src/sdk-adapter.ts";

class ProbeFailure extends Schema.TaggedError<ProbeFailure>()("ProbeFailure", {
  reason: Schema.String,
}) {}

const executable = process.env.RAT_KING_CLAUDE_EXECUTABLE;

it.live.skipIf(
  executable === undefined || process.env.RAT_KING_CLAUDE_HELPER_PROBE !== "1"
)(
  "inline helper authenticates with dummy credential and no inherited env",
  () =>
    Effect.gen(function* probe() {
      if (executable === undefined) {
        return yield* new ProbeFailure({
          reason: "Missing dedicated executable",
        });
      }

      const directory = yield* Effect.tryPromise({
        catch: (cause) => new ProbeFailure({ reason: String(cause) }),
        try: () => mkdtemp(path.join(tmpdir(), "rat-king-helper-probe-")),
      });

      const apiKeyFile = path.join(directory, "dummy");
      yield* Effect.tryPromise({
        catch: (cause) => new ProbeFailure({ reason: String(cause) }),
        try: () =>
          writeFile(apiKeyFile, "rk-dummy-helper-value", { mode: 0o600 }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          execFile("trash", [directory], () => {
            resume(Effect.succeed(true));
          });
        })
      );

      const captured: {
        credential: string | undefined;
        pathname: string | undefined;
      }[] = [];

      const names: string[][] = [];
      let notify: (() => void) | undefined;

      const server = createServer((request, response) => {
        captured.push({
          credential:
            request.headers["x-api-key"]?.toString() ??
            request.headers.authorization,
          pathname: request.url,
        });

        if (request.url?.startsWith("/v1/") === true) {
          notify?.();
        }

        response
          .writeHead(request.url?.startsWith("/v1/") === true ? 401 : 404, {
            "content-type": "application/json",
          })
          .end(
            JSON.stringify({
              error: {
                message: "Dummy capture only",
                type: "authentication_error",
              },
              type: "error",
            })
          );
      });

      yield* Effect.addFinalizer(() =>
        Effect.callback<boolean>((resume) => {
          server.closeAllConnections();
          server.close(() => {
            resume(Effect.succeed(true));
          });
        })
      );

      const port = yield* Effect.callback<number, ProbeFailure>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();

          if (address === null || Schema.is(Schema.String)(address)) {
            resume(
              Effect.fail(new ProbeFailure({ reason: "Missing capture port" }))
            );
          } else {
            resume(Effect.succeed(address.port));
          }
        });
      });

      vi.stubEnv("RK_PROBE_INHERITED_CANARY", "must-not-reach-claude");

      try {
        yield* Effect.gen(function* queryCapture() {
          const driver = yield* ModelDriver;
          yield* driver
            .turn({
              messages: [{ content: "Reply hi", role: "user" }],
              model: MODEL,
              stream: true,
            })
            .pipe(Effect.ignore, Effect.forkScoped);
          yield* Effect.callback<boolean>((resume) => {
            notify = () => {
              resume(Effect.succeed(true));
            };

            if (
              captured.some(
                (request) => request.pathname?.startsWith("/v1/") === true
              )
            ) {
              notify();
            }
          }).pipe(Effect.timeout("15 seconds"));
        }).pipe(
          Effect.provide(
            sdkLayer(executable, {
              apiKeyFile,
              baseUrl: `http://127.0.0.1:${port}`,
              observeChild: (keys) => {
                names.push([...keys]);
              },
            })
          )
        );
        yield* Effect.log(
          `Dummy auth captured: ${captured.some((request) => request.credential === "rk-dummy-helper-value" || request.credential === "Bearer rk-dummy-helper-value")}; inherited canary absent: ${names[0]?.includes("RK_PROBE_INHERITED_CANARY") === false}`
        );
        expect(
          captured.some(
            (request) =>
              request.pathname?.startsWith("/v1/") === true &&
              (request.credential === "rk-dummy-helper-value" ||
                request.credential === "Bearer rk-dummy-helper-value")
          )
        ).toBe(true);
        expect(names).toHaveLength(1);
        expect(names[0]).not.toContain("RK_PROBE_INHERITED_CANARY");
        expect(
          names[0]?.every((name) =>
            [
              "PATH",
              "HOME",
              "CLAUDE_CONFIG_DIR",
              "ANTHROPIC_BASE_URL",
              "DISABLE_AUTOUPDATER",
              "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
              "DISABLE_AUTO_COMPACT",
              "ENABLE_CLAUDEAI_MCP_SERVERS",
              "CLAUDE_CODE_ENTRYPOINT",
              "CLAUDE_AGENT_SDK_VERSION",
            ].includes(name)
          )
        ).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }

      return true;
    }).pipe(Effect.scoped),
  45_000
);
