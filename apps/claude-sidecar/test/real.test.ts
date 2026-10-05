/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Owned subprocess and loopback proof boundaries. */
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off globalFetch:off -- Host-only proof owns its processes, files and loopback requests.
import type { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

class ProofFailure extends Schema.TaggedError<ProofFailure>()("ProofFailure", {
  reason: Schema.String,
}) {}

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new ProofFailure({ reason: String(cause) }),
    try: run,
  });

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify consumes the callback and ignores execFile's process return.
const execute = promisify(execFile);

const stop = (child: ChildProcess) =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
    child.kill("SIGTERM");
  }).pipe(
    Effect.timeout("8 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.callback<boolean>((resume) => {
        child.once("exit", () => {
          resume(Effect.succeed(true));
        });
        child.kill("SIGKILL");
      }).pipe(Effect.timeout("5 seconds"))
    )
  );

const launch = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  marker: string,
  log: string
) =>
  Effect.gen(function* launchOwned() {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
      ),
      (owned) => stop(owned).pipe(Effect.orDie)
    );

    const output = yield* Effect.callback<string, ProofFailure>((resume) => {
      let text = "";

      const data = (chunk: Buffer) => {
        text += chunk.toString();

        if (text.includes(marker)) {
          resume(Effect.succeed(text));
        }
      };

      const error = (cause: Error) => {
        resume(Effect.fail(new ProofFailure({ reason: String(cause) })));
      };

      const exit = () => {
        resume(
          Effect.fail(
            new ProofFailure({ reason: `Process exited: ${text.slice(-2000)}` })
          )
        );
      };

      child.stdout?.on("data", data);
      child.stderr?.on("data", data);
      child.once("error", error);
      child.once("exit", exit);

      return Effect.sync(() => {
        child.stdout?.off("data", data);
        child.stderr?.off("data", data);
        child.off("error", error);
        child.off("exit", exit);
      });
    }).pipe(Effect.timeout("25 seconds"));

    child.stdout?.on("data", (chunk: Buffer) => {
      void writeFile(log, chunk, { flag: "a" });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      void writeFile(log, chunk, { flag: "a" });
    });

    return { child, output };
  });

const freePort = Effect.callback<number, ProofFailure>((resume) => {
  const server = createServer();
  server.once("error", (cause) => {
    resume(Effect.fail(new ProofFailure({ reason: String(cause) })));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    if (address === null || Schema.is(Schema.String)(address)) {
      resume(Effect.fail(new ProofFailure({ reason: "No loopback port" })));
    } else {
      server.close(() => {
        resume(Effect.succeed(address.port));
      });
    }
  });
});

const getJson = (url: string, init?: RequestInit) =>
  io(async () => {
    const response = await fetch(url, init);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 2000)}`);
    }

    const value: unknown = JSON.parse(text);

    return value;
  });

const binary = process.env.RAT_KING_CELLD;

it.live.skipIf(
  binary === undefined ||
    binary === "" ||
    process.env.RAT_KING_CLAUDE_SIDECAR !== "1"
)(
  "one real Opus turn and durable add tool settle inside celld",
  () =>
    Effect.gen(function* proof() {
      if (binary === undefined || binary === "") {
        return yield* new ProofFailure({ reason: "Missing celld" });
      }

      const hash = createHash("sha256")
        .update(yield* io(() => readFile(binary)))
        .digest()
        .toString("hex");

      expect(hash).toBe(
        "91f6d7a470720c300efddf75e666f121c0f51bbaf7a245d9d76efffaefeecf57"
      );

      const directory = yield* io(() =>
        mkdtemp(path.join(tmpdir(), "rat-king-sidecar-proof-"))
      );

      const token = randomBytes(32).toString("hex");
      const tokenFile = path.join(directory, "bearer");
      yield* io(() => writeFile(tokenFile, token, { mode: 0o600 }));
      const cli = path.join(directory, "sidecar.mjs");

      const sidecarBuild = yield* io(() =>
        build({
          banner: {
            js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
          },
          bundle: true,
          entryPoints: [path.resolve("apps/claude-sidecar/src/cli.ts")],
          external: ["@anthropic-ai/claude-agent-sdk"],
          format: "esm",
          outfile: cli,
          platform: "node",
          tsconfigRaw: { compilerOptions: {} },
        })
      );

      expect(sidecarBuild.errors).toHaveLength(0);
      yield* io(() =>
        symlink(
          path.resolve("apps/claude-sidecar/node_modules"),
          path.join(directory, "node_modules"),
          "dir"
        )
      );

      const sidecar = yield* launch(
        process.execPath,
        [cli],
        {
          ...process.env,
          RAT_KING_CLAUDE_EXECUTABLE: process.env.RAT_KING_CLAUDE_EXECUTABLE,
          RAT_KING_SIDECAR_TOKEN_FILE: tokenFile,
        },
        '"baseUrl":',
        path.join(directory, "sidecar.log")
      );

      const line = sidecar.output
        .split("\n")
        .find((value) => value.startsWith('{"baseUrl":'));

      if (line === undefined) {
        return yield* new ProofFailure({ reason: "Missing sidecar readiness" });
      }

      const ready = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ baseUrl: Schema.String })
      )(JSON.parse(line));

      yield* io(() =>
        build({
          bundle: true,
          entryPoints: [
            path.resolve("apps/claude-sidecar/test/worker/worker.ts"),
          ],
          external: ["cloudflare:workers"],
          format: "esm",
          minify: true,
          outfile: path.join(directory, "worker.js"),
          platform: "browser",
        })
      );
      yield* io(() =>
        writeFile(
          path.join(directory, "wrangler.json"),
          JSON.stringify({
            compatibility_date: "2026-10-05",
            durable_objects: {
              bindings: [{ class_name: "Agent", name: "AGENT" }],
            },
            main: "worker.js",
            migrations: [{ new_sqlite_classes: ["Agent"], tag: "v1" }],
            name: "sidecar-proof",
            vars: { SIDECAR_BASE: ready.baseUrl },
          })
        )
      );
      yield* io(() =>
        writeFile(
          path.join(directory, ".dev.vars"),
          `SIDECAR_CREDENTIAL=${token}\n`,
          { mode: 0o600 }
        )
      );
      yield* Effect.addFinalizer(() =>
        io(() =>
          execute("trash", [tokenFile, path.join(directory, ".dev.vars")])
        ).pipe(Effect.orDie)
      );
      const port = yield* freePort;

      const celld = yield* launch(
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
          ...process.env,
          CELLD_ESBUILD: path.resolve(
            "apps/claude-sidecar/node_modules/.bin/esbuild"
          ),
          NO_COLOR: "1",
        },
        "ready  http://",
        path.join(directory, "celld.log")
      );

      const children = yield* io(() =>
        execute("pgrep", ["-P", String(celld.child.pid)])
      );

      const nodePid = yield* Schema.decodeEffect(Schema.Int)(
        Number(children.stdout.trim())
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(nodePid, "SIGTERM");
          } catch {
            process.exitCode ??= 0;
          }
        })
      );
      const base = `http://127.0.0.1:${port}`;

      const admitted = yield* getJson(`${base}/submit`, {
        body: JSON.stringify({
          content:
            "Use the add tool to add 2 and 3, then answer with the number.",
          requestId: "opus-add-1",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }))
        )
      );

      const settlement = yield* getJson(`${base}/wait?id=${admitted.id}`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              _tag: Schema.String,
              answer: Schema.optionalKey(Schema.String),
            })
          )
        )
      );

      const evidence = yield* getJson(`${base}/evidence`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              entries: Schema.Array(Schema.Struct({ record: Schema.String })),
              submissions: Schema.Array(
                Schema.Struct({ status: Schema.String })
              ),
            })
          )
        )
      );

      const metrics = yield* getJson(`${ready.baseUrl}/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });

      const rss = yield* io(() =>
        execute("ps", ["-o", "rss=", "-p", String(sidecar.child.pid)])
      );

      const receipt = {
        celldPid: nodePid,
        evidence,
        metrics,
        settlement,
        sidecarPid: sidecar.child.pid,
        sidecarRssKiB: Number(rss.stdout.trim()),
      };

      yield* io(() =>
        writeFile(
          path.join(directory, "receipt.json"),
          JSON.stringify(receipt, null, 2)
        )
      );
      yield* Effect.log(`S4b proof receipt: ${JSON.stringify(receipt)}`);
      expect(settlement._tag).toBe("Done");
      expect(settlement.answer).toContain("5");
      expect(
        evidence.entries.filter((entry) =>
          entry.record.includes('"type":"toolCall"')
        )
      ).toHaveLength(1);
      expect(
        evidence.entries.filter((entry) =>
          entry.record.includes('"role":"toolResult"')
        )
      ).toHaveLength(1);

      const resultEntry = evidence.entries.find((entry) =>
        entry.record.includes('"role":"toolResult"')
      );

      expect(resultEntry?.record).toContain('"text":"5"');
      expect(resultEntry?.record).not.toContain('"isError":true');
      expect(evidence.submissions).toEqual([
        expect.objectContaining({ status: "done" }),
      ]);

      return true;
    }).pipe(Effect.scoped),
  180_000
);
