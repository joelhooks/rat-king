// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Host diagnostics capture and filesystem fixtures.
import {
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { expect, vi } from "vitest";

import { logHttpFailure } from "../src/diagnostics.ts";
import { MODEL, SidecarFailure } from "../src/port.ts";
import {
  CredentialRefusalError,
  logCredentialRefusal,
  requireBearer,
  runningUid,
  validatePrivateFile,
} from "../src/private-file.ts";
import { serve } from "../src/server.ts";

const secret = "known-secret-value-never-log-this-123456789";

const checks = ["owner", "mode", "symlink", "file_type", "size", "length"];

for (const check of checks) {
  it.live.prop(
    `logs credential ${check} refusal with its component`,
    [Arbitrary.schema(Schema.String)],
    ([suffix]) =>
      Effect.promise(async () => {
        const root = await realpath(new URL("..", import.meta.url));
        const directory = await mkdtemp(path.join(root, ".diagnostics-test-"));

        const capture = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const file = path.join(directory, "credential");
          await writeFile(file, secret, { mode: 0o600 });
          const link = path.join(directory, "link");
          await symlink(file, link);
          const component = path.resolve(`${file}${suffix}`);

          let metadata = await stat(file);

          if (check === "file_type") {
            metadata = await stat(directory);
          } else if (check === "symlink") {
            metadata = await lstat(link);
          }

          if (check === "owner") {
            metadata.uid = runningUid() + 1;
          }

          if (check === "mode") {
            metadata.mode = 0o10_0644;
          }

          if (check === "size") {
            metadata.size = 0;
          }

          let refused = false;

          try {
            if (check === "length") {
              requireBearer("short", component);
            } else {
              validatePrivateFile(metadata, component);
            }
          } catch (error) {
            refused = true;
            expect(error).toBeInstanceOf(CredentialRefusalError);
            logCredentialRefusal(error, component);
          }

          expect(refused).toBe(true);
          expect(capture.mock.calls).toEqual([
            [
              JSON.stringify({
                check,
                component,
                event: "sidecar_credential_refusal",
              }),
            ],
          ]);
        } finally {
          capture.mockRestore();
          await rm(directory, { force: true, recursive: true });
        }
      }),
    { arbitrary: { runs: 5 } }
  );
}

it.live.prop(
  "untrusted errors and known credentials never enter captured output",
  [Arbitrary.schema(Schema.String)],
  ([suffix]) =>
    Effect.sync(() => {
      const capture = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        logHttpFailure(
          400,
          "sdk_error",
          new SidecarFailure({ reason: `${secret}${suffix}` })
        );
        logHttpFailure(
          400,
          "policy_refusal",
          new Error(`JSON body ${secret}${suffix}`)
        );
        logCredentialRefusal(new Error(secret), "/invented/credential");
        const output = JSON.stringify(capture.mock.calls);
        expect(output).not.toContain(secret);
        expect(output).toContain("SidecarFailure");
        expect(output).toContain("Untrusted error detail omitted");
      } finally {
        capture.mockRestore();
      }
    })
);

for (const sample of [
  {
    authorized: true,
    body: secret.repeat(30_000),
    kind: "stream_error",
    message: "Request exceeds 1 MiB",
    name: "oversize stream",
    route: "/v1/chat/completions",
    status: 400,
  },
  {
    authorized: false,
    body: "{}",
    kind: "policy_refusal",
    message: "Authorization refused",
    name: "authorization",
    route: "/v1/chat/completions",
    status: 401,
  },
  {
    authorized: true,
    body: "{}",
    kind: "policy_refusal",
    message: "Route not found",
    name: "route",
    route: "/missing",
    status: 404,
  },
  {
    authorized: true,
    body: secret,
    kind: "policy_refusal",
    message: "Untrusted error detail omitted",
    name: "invalid JSON",
    route: "/v1/chat/completions",
    status: 400,
  },
  {
    authorized: true,
    body: JSON.stringify({
      messages: [{ content: `/model ${secret}`, role: "user" }],
      model: MODEL,
      stream: true,
    }),
    kind: "policy_refusal",
    message: "Command-form user text is not accepted",
    name: "command",
    route: "/v1/chat/completions",
    status: 400,
  },
  {
    authorized: true,
    body: JSON.stringify({ messages: [], model: secret, stream: true }),
    kind: "model_error",
    message: "Unsupported model",
    name: "model",
    route: "/v1/chat/completions",
    status: 400,
  },
  {
    authorized: true,
    body: JSON.stringify({
      messages: [{ content: secret, role: "user" }],
      model: MODEL,
      stream: true,
    }),
    kind: "sdk_error",
    message: "Untrusted error detail omitted",
    name: "SDK",
    route: "/v1/chat/completions",
    status: 400,
  },
]) {
  it.live.prop(
    `HTTP ${sample.name} failure logs exactly one safe line`,
    [Arbitrary.schema(Schema.String)],
    ([suffix]) =>
      Effect.gen(function* httpLog() {
        const capture = vi.spyOn(console, "error").mockImplementation(() => {});

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            capture.mockRestore();
          })
        );

        const server = yield* serve(secret, "/invented/missing-claude", {
          apiKeyFile: "/invented/key",
          baseUrl: "http://127.0.0.1:1",
        });

        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${server.baseUrl}${sample.route}`, {
            headers: {
              authorization: `Bearer ${sample.authorized ? secret : Buffer.from(suffix).toString("hex")}`,
            },
          }).pipe(HttpClientRequest.bodyText(sample.body))
        ).pipe(Effect.provide(FetchHttpClient.layer));

        expect(response.status).toBe(sample.status);
        yield* response.text;
        expect(capture.mock.calls).toHaveLength(1);
        const line = String(capture.mock.calls[0]?.[0]);
        expect(line).toContain(`"kind":"${sample.kind}"`);
        expect(line).toContain(`"message":"${sample.message}"`);
        expect(line).not.toContain(secret);
        expect(line.split("\n")).toHaveLength(1);
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 2 }, timeout: 20_000 }
  );
}
