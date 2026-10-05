/* oxlint-disable typescript/promise-function-async -- Owned Node fixture Promise thunks. */
// @effect-diagnostics nodeBuiltinImport:off -- Real-node fixture files.
// @effect-diagnostics globalFetch:off -- Loopback-only test transport.
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Fiber, Ref, Schedule, Schema } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

import { Settlement, SubmissionId } from "../src/port.ts";
import {
  freePort,
  io,
  json,
  kill,
  launch,
  ProofFailure,
  rss,
} from "./celld-process.ts";

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
              /node_modules\/(?:@aws-sdk\/|@google\/genai\/|@earendil-works\/pi-ai\/dist\/index)/u.test(
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
