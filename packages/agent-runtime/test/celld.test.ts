/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Effect adapters for the owned Node process and HTTP proof use SDK Promise thunks. */
// @effect-diagnostics nodeBuiltinImport:off -- The real-node proof owns its subprocess, temporary files and RSS probe.
// @effect-diagnostics globalFetch:off -- Loopback-only test transport, not production HTTP policy.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { Effect, Fiber, Ref, Schedule, Schema } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

import { Settlement, SubmissionId } from "../src/port.ts";

class ProofFailure extends Schema.TaggedError<ProofFailure>()("ProofFailure", {
  reason: Schema.String,
}) {}

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new ProofFailure({ reason: String(cause) }),
    try: run,
  });

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify deliberately consumes execFile\u0027s callback overload and ignores its ChildProcess return.
const execute = promisify(execFile);

const freePort = Effect.callback<number, ProofFailure>((resume) => {
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

const stop = (child: ChildProcess, signal: NodeJS.Signals) =>
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

const launch = (binary: string, directory: string, port: number) =>
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

const kill = (node: { pid: number; supervisor: ChildProcess }) =>
  Effect.gen(function* crash() {
    yield* Effect.sync(() => {
      process.kill(node.pid, "SIGKILL");
    });
    yield* stop(node.supervisor, "SIGKILL");
  });

const rss = (node: { pid: number }) =>
  io(() => execute("ps", ["-o", "rss=", "-p", String(node.pid)])).pipe(
    Effect.flatMap(({ stdout }) =>
      Schema.decodeUnknownEffect(Schema.Int)(Number(stdout.trim()))
    )
  );

const json = (
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

const Admission = Schema.Struct({ id: SubmissionId, requestId: Schema.String });

const Row = Schema.Struct({ id: Schema.Int, record: Schema.String });

const Evidence = Schema.Struct({
  calls: Schema.Int,
  entered: Schema.optionalKey(Schema.Struct({ value: Schema.Int })),
  entries: Schema.Array(Row),
  submissions: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      request_id: Schema.NullOr(Schema.fromJsonString(Schema.String)),
      status: Schema.String,
    })
  ),
  tasks: Schema.Array(
    Schema.Struct({
      kind: Schema.fromJsonString(Schema.String),
      record: Schema.String,
      status: Schema.String,
    })
  ),
});

const evidence = (base: string) =>
  json(base, "/evidence").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Evidence))
  );

const binary = process.env.RAT_KING_CELLD;

it.live.skipIf(binary === undefined || binary === "")(
  "celld DO answers, survives SIGKILL and resumes a committed tool checkpoint once",
  () =>
    Effect.gen(function* proof() {
      if (binary === undefined || binary === "") {
        return yield* new ProofFailure({
          reason: "RAT_KING_CELLD is required",
        });
      }

      const directory = yield* io(() =>
        mkdtemp(path.join(tmpdir(), "rat-king-agent-proof-"))
      );

      const bundle = path.join(directory, "worker.js");

      const built = yield* io(() =>
        build({
          bundle: true,
          entryPoints: [path.resolve("packages/agent-runtime/test/worker.ts")],
          external: ["cloudflare:workers"],
          format: "esm",
          metafile: true,
          minify: true,
          outfile: bundle,
          platform: "browser",
          target: "es2023",
        })
      );

      expect(
        Object.values(built.metafile.outputs).some((output) =>
          Object.entries(output.inputs).some(
            ([file, contribution]) =>
              contribution.bytesInOutput > 0 &&
              /node_modules\/(?:@aws-sdk\/|@anthropic-ai\/|@google\/genai\/|@earendil-works\/pi-ai\/dist\/index)/u.test(
                file
              )
          )
        )
      ).toBe(false);
      const bundleBytes = (yield* io(() => stat(bundle))).size;
      yield* io(() =>
        writeFile(
          path.join(directory, "wrangler.json"),
          JSON.stringify({
            compatibility_date: "2026-10-04",
            durable_objects: {
              bindings: [{ class_name: "Agent", name: "AGENT" }],
            },
            main: "worker.js",
            migrations: [{ new_sqlite_classes: ["Agent"], tag: "v1" }],
            name: "agent-proof",
          })
        )
      );
      const port = yield* freePort;
      const base = `http://127.0.0.1:${port}`;
      const first = yield* launch(binary, directory, port);
      const idleKiB = yield* rss(first);
      yield* io(() => fetch(`${base}/idle`));
      yield* evidence(base);
      const loadedKiB = yield* rss(first);
      const peak = yield* Ref.make(loadedKiB);

      const sample = rss(first).pipe(
        Effect.flatMap((value) =>
          Ref.update(peak, (previous) => Math.max(previous, value))
        )
      );

      const sampler = yield* sample.pipe(
        Effect.repeat(Schedule.spaced("25 millis")),
        Effect.forkScoped
      );

      const ordinary = yield* json(base, "/submit", {
        content: "hello",
        requestId: "ordinary-1",
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Admission)));

      const done = yield* json(base, `/wait?id=${ordinary.id}`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Settlement))
      );

      expect(done).toEqual(
        Settlement.cases.Done.make({
          answer: "ordinary answer",
          id: ordinary.id,
        })
      );

      const slow = yield* json(base, "/submit", {
        content: "slow",
        requestId: "restart-1",
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Admission)));

      const before = yield* evidence(base).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (value) => value.entered?.value === 1,
        }),
        Effect.timeout("5 seconds")
      );

      yield* io(() =>
        writeFile(path.join(directory, "before.json"), JSON.stringify(before))
      );

      const original = before.entries.filter((entry) =>
        entry.record.includes('"type":"toolCall"')
      );

      expect(original).toHaveLength(1);
      expect(before.calls).toBe(2);
      expect(
        before.tasks.some(
          (task) =>
            task.kind === "pi.tool" &&
            task.status === "running" &&
            task.record.includes('"phase":"execute"')
        )
      ).toBe(true);
      expect(
        before.submissions.find((submission) => submission.id === slow.id)
      ).toMatchObject({ request_id: "restart-1", status: "placed" });
      yield* sample;
      yield* Fiber.interrupt(sampler);
      yield* kill(first);
      const peakBeforeKillKiB = yield* Ref.get(peak);
      yield* Effect.sync(() => {
        process.stdout.write(
          "SIGKILL observed on the isolate node during tool execution; restarting celld on the same data directory\n"
        );
      });

      const second = yield* launch(binary, directory, port);
      yield* rss(second).pipe(
        Effect.flatMap((value) =>
          Ref.update(peak, (previous) => Math.max(previous, value))
        ),
        Effect.repeat(Schedule.spaced("25 millis")),
        Effect.forkScoped
      );

      const recovered = yield* json(base, `/release?id=${slow.id}`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Settlement))
      );

      expect(recovered).toEqual(
        Settlement.cases.Done.make({
          answer: "resumed answer",
          id: slow.id,
        })
      );

      const duplicate = yield* json(base, "/submit", {
        content: "slow",
        requestId: "restart-1",
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Admission)));

      expect(duplicate).toEqual(slow);
      const after = yield* evidence(base);
      expect(after.calls).toBe(1);
      yield* io(() =>
        writeFile(path.join(directory, "after.json"), JSON.stringify(after))
      );
      expect(
        after.entries.filter((entry) =>
          entry.record.includes('"type":"toolCall"')
        )
      ).toEqual(original);
      expect(
        after.entries.filter((entry) =>
          entry.record.includes('"kind":"pi.tool-result"')
        )
      ).toHaveLength(1);
      expect(
        after.entries.filter((entry) =>
          entry.record.includes('"text":"resumed answer"')
        )
      ).toHaveLength(1);
      expect(
        after.submissions.find((submission) => submission.id === slow.id)
      ).toMatchObject({ request_id: "restart-1", status: "done" });
      const restartedKiB = yield* rss(second);
      yield* Ref.update(peak, (previous) => Math.max(previous, restartedKiB));

      const peakDuringRunKiB = yield* Ref.get(peak);

      const measurement = {
        bundleBytes,
        idleKiB,
        loadedKiB,
        peakBeforeKillKiB,
        peakDuringRunKiB,
        restartedKiB,
      };

      yield* io(() =>
        writeFile(
          path.join(directory, "measurement.json"),
          JSON.stringify(measurement)
        )
      );
      yield* Effect.sync(() => {
        process.stdout.write(
          `Restart settled done: one persisted tool-call response, one tool result, one final answer; submission and request IDs unchanged\nRSS (KiB), bundle (bytes): ${JSON.stringify(measurement)}\n`
        );
      });

      return measurement;
    })
);
