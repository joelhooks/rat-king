/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Owned Node process and loopback HTTP proof boundaries. */
// @effect-diagnostics nodeBuiltinImport:off -- Test subprocess and port ownership.
// @effect-diagnostics globalFetch:off -- Loopback-only test transport.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { Effect, Schema } from "effect";
import { expect } from "vitest";

export class ProofFailure extends Schema.TaggedError<ProofFailure>()(
  "ProofFailure",
  {
    reason: Schema.String,
  }
) {}

export const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new ProofFailure({ reason: String(cause) }),
    try: run,
  });

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify deliberately consumes execFile\u0027s callback overload and ignores its ChildProcess return.
const execute = promisify(execFile);

export const freePort = Effect.callback<number, ProofFailure>((resume) => {
  const server = createServer();
  server.once("error", (error) => {
    resume(Effect.fail(new ProofFailure({ reason: String(error) })));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    if (address === null || Schema.is(Schema.String)(address)) {
      resume(
        Effect.fail(new ProofFailure({ reason: "Missing loopback port" }))
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

export const stop = (child: ChildProcess, signal: NodeJS.Signals) =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
    child.kill(signal);
  });

export const launch = (binary: string, directory: string, port: number) =>
  Effect.gen(function* launchNode() {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(
          binary,
          [
            "dev",
            directory,
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--no-watch",
          ],
          {
            env: {
              ...process.env,
              CELLD_ESBUILD: path.resolve(
                "packages/agent-runtime/node_modules/.bin/esbuild"
              ),
              NO_COLOR: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        )
      ),
      (owned) =>
        stop(owned, "SIGTERM").pipe(Effect.timeout("5 seconds"), Effect.orDie)
    );

    yield* Effect.callback<boolean, ProofFailure>((resume) => {
      let output = "";

      const onOutput = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-12_000);

        if (output.includes("ready  http://")) {
          resume(Effect.succeed(true));
        }
      };

      const failed = (error: Error) => {
        resume(Effect.fail(new ProofFailure({ reason: String(error) })));
      };

      const exited = (code: number | null) => {
        resume(
          Effect.fail(
            new ProofFailure({ reason: `celld exited ${code}: ${output}` })
          )
        );
      };

      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      child.once("error", failed);
      child.once("exit", exited);

      return Effect.sync(() => {
        child.stdout?.off("data", onOutput);
        child.stderr?.off("data", onOutput);
        child.off("error", failed);
        child.off("exit", exited);
      });
    }).pipe(Effect.timeout("20 seconds"));

    const children = yield* io(() =>
      execute("pgrep", ["-P", String(child.pid)])
    );

    const pid = yield* Schema.decodeEffect(Schema.Int)(
      Number(children.stdout.trim())
    );

    const command = yield* io(() =>
      execute("ps", ["-o", "command=", "-p", String(pid)])
    );

    expect(command.stdout).toContain("--no-control-plane");
    expect(command.stdout).toContain(`--listen 127.0.0.1:${port}`);

    return { pid, supervisor: child };
  });

export const kill = (node: { pid: number; supervisor: ChildProcess }) =>
  Effect.gen(function* crash() {
    yield* Effect.sync(() => {
      process.kill(node.pid, "SIGKILL");
    });
    yield* stop(node.supervisor, "SIGKILL");
  });

export const rss = (node: { pid: number }) =>
  io(() => execute("ps", ["-o", "rss=", "-p", String(node.pid)])).pipe(
    Effect.flatMap(({ stdout }) =>
      Schema.decodeUnknownEffect(Schema.Int)(Number(stdout.trim()))
    )
  );

export const json = (
  base: string,
  pathname: string,
  input?: { content: string; requestId: string }
) =>
  io(() =>
    fetch(
      `${base}${pathname}`,
      input
        ? {
            body: JSON.stringify(input),
            headers: { "content-type": "application/json" },
            method: "POST",
          }
        : {}
    )
  ).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* body() {
        const text = yield* io(() => response.text());

        if (!response.ok) {
          return yield* new ProofFailure({
            reason: `HTTP ${response.status}: ${text}`,
          });
        }

        return yield* Effect.try({
          catch: (cause) => new ProofFailure({ reason: String(cause) }),
          try: () => {
            const parsed: unknown = JSON.parse(text);

            return parsed;
          },
        });
      })
    )
  );
