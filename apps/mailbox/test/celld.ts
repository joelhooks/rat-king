// @effect-diagnostics nodeBuiltinImport:off -- Owned celld test process.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";

import { configuration } from "../src/bindings.ts";

/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node adapters. */
export class TestFailure extends Schema.TaggedError<TestFailure>()(
  "TestFailure",
  {
    message: Schema.String,
  }
) {}

export const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => new TestFailure({ message: "Integration I/O failed" }),
    try: operation,
  });

const freePort = Effect.callback<number, TestFailure>((resume) => {
  const server = createServer();
  server.once("error", () => {
    resume(Effect.fail(new TestFailure({ message: "Port allocation failed" })));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    if (address === null || Schema.is(Schema.String)(address)) {
      server.close();
      resume(
        Effect.fail(new TestFailure({ message: "Missing listener address" }))
      );

      return;
    }

    server.close(() => {
      resume(Effect.succeed(address.port));
    });
  });

  return Effect.sync(() => {
    server.close();
  });
});

export const celldNode = (binary: string, documentsJson: string) =>
  Effect.gen(function* launch() {
    const directory = yield* io(() =>
      mkdtemp(path.join(tmpdir(), "rat-king-p4-"))
    );

    const source = JSON.stringify(path.resolve("apps/mailbox/test/worker.ts"));
    yield* io(() =>
      writeFile(
        path.join(directory, "worker.ts"),
        `export { default, Mailbox, AuthTokens } from ${source};`
      )
    );
    yield* io(() =>
      writeFile(
        path.join(directory, "wrangler.json"),
        JSON.stringify(
          configuration("worker.ts", {
            commit: "b845798-proof",
            documents: documentsJson,
            serviceDid: "did:web:service.example",
            version: "0.1.0-proof",
          })
        )
      )
    );
    const port = yield* freePort;

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(
          binary,
          ["dev", directory, "--port", String(port), "--no-watch"],
          {
            env: {
              ...process.env,
              CELLD_ESBUILD: path.resolve(
                "apps/mailbox/node_modules/.bin/esbuild"
              ),
              NO_COLOR: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        )
      ),
      (owned) =>
        Effect.sync(() => {
          owned.kill("SIGTERM");
        })
    );

    yield* Effect.callback<boolean, TestFailure>((resume) => {
      let output = "";

      const onOutput = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);

        if (output.includes("ready  http://")) {
          resume(Effect.succeed(true));
        }
      };

      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);
      child.once("error", () => {
        resume(Effect.fail(new TestFailure({ message: "celld spawn failed" })));
      });
      child.once("exit", (code) => {
        resume(
          Effect.fail(
            new TestFailure({ message: `celld exited ${code}: ${output}` })
          )
        );
      });

      return Effect.sync(() => {
        child.stdout.off("data", onOutput);
        child.stderr.off("data", onOutput);
      });
    }).pipe(Effect.timeout("20 seconds"));

    return `http://127.0.0.1:${port}`;
  });
