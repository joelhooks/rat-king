// @effect-diagnostics nodeBuiltinImport:off -- This real-node proof owns private temporary config and subprocess cleanup.
/* oxlint-disable typescript/promise-function-async -- Files and esbuild expose Promise thunks. */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { build } from "esbuild";
import { expect } from "vitest";

import { Settlement, SubmissionId } from "../src/port.ts";
import { freePort, io, json, launch, ProofFailure } from "./celld-process.ts";

const readable = (file: string | undefined) => {
  if (file === undefined || file === "") {
    return false;
  }

  try {
    accessSync(file, constants.R_OK);

    return true;
  } catch {
    return false;
  }
};

const binary = process.env.RAT_KING_CELLD;

const keyFile = process.env.RAT_KING_MODEL_GATEWAY_KEY_FILE;

const endpointFile = process.env.RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE;

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify consumes execFile's callback overload.
const execute = promisify(execFile);

const Admission = Schema.Struct({ id: SubmissionId });

const Usage = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      totalTokens: Schema.Finite,
    })
  ),
});

const Evidence = Schema.Struct({
  usage: Schema.Array(Schema.Struct({ record: Schema.fromJsonString(Usage) })),
});

const realProof = (model: "gpt-6-sol" | "claude-opus-5-5") =>
  Effect.gen(function* proof() {
    if (
      binary === undefined ||
      binary === "" ||
      keyFile === undefined ||
      endpointFile === undefined
    ) {
      return yield* new ProofFailure({
        reason: "All three proof inputs are required",
      });
    }

    const apiKey = (yield* io(() => readFile(keyFile, "utf-8"))).trim();
    const baseUrl = (yield* io(() => readFile(endpointFile, "utf-8"))).trim();

    const redact = (text: string) => {
      let result = text;

      for (const secret of [apiKey, baseUrl, new URL(baseUrl).hostname]) {
        if (secret !== "") {
          result = result.replaceAll(secret, "[REDACTED]");
        }
      }

      return result;
    };

    return yield* Effect.gen(function* turn() {
      const directory = yield* Effect.acquireRelease(
        io(() => mkdtemp(path.join(tmpdir(), "rat-king-model-gateway-proof-"))),
        (owned) => io(() => execute("trash", [owned])).pipe(Effect.orDie)
      );

      const built = yield* io(() =>
        build({
          bundle: true,
          entryPoints: [path.resolve("packages/agent-runtime/test/worker.ts")],
          external: ["cloudflare:workers"],
          format: "esm",
          metafile: true,
          minify: true,
          outfile: path.join(directory, "worker.js"),
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
      const config = path.join(directory, "wrangler.json");
      yield* io(() =>
        writeFile(
          config,
          JSON.stringify({
            compatibility_date: "2026-10-04",
            durable_objects: {
              bindings: [{ class_name: "Agent", name: "AGENT" }],
            },
            main: "worker.js",
            migrations: [{ new_sqlite_classes: ["Agent"], tag: "v1" }],
            name: "model-gateway-proof",
            vars: {
              MODEL_GATEWAY_BASE_URL: baseUrl,
              MODEL_GATEWAY_MODEL: "gpt-6-sol",
            },
          }),
          { mode: 0o600 }
        )
      );
      const secrets = path.join(directory, ".dev.vars");
      yield* io(() =>
        writeFile(
          secrets,
          `MODEL_GATEWAY_CREDENTIAL=${JSON.stringify(apiKey)}\n`,
          {
            mode: 0o600,
          }
        )
      );
      expect((yield* io(() => stat(config))).mode % 512).toBe(0o600);
      expect((yield* io(() => stat(secrets))).mode % 512).toBe(0o600);
      const port = yield* freePort;
      yield* launch(binary, directory, port);
      const base = `http://127.0.0.1:${port}`;

      const admission = yield* json(base, `/submit?model=${model}`, {
        content: "What is 2 + 2? Answer in one short line.",
        requestId: `model-gateway-${model}-1`,
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Admission)));

      const settled = yield* json(
        base,
        `/wait?id=${admission.id}&model=${model}`
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Settlement)));

      if (model === "claude-opus-5-5") {
        yield* Effect.sync(() => {
          process.stdout.write(
            Settlement.guards.Done(settled)
              ? "OPUS_SUCCEEDED_PAID_EXTRA_USAGE_STOP: no more model calls; owner decision required\n"
              : `Opus not proven; one native messages request, no retry: ${redact(settled.reason)}\n`
          );
        });

        return [];
      }

      if (Settlement.guards.Unanswered(settled)) {
        return yield* new ProofFailure({ reason: redact(settled.reason) });
      }

      expect(settled.answer.trim().length).toBeGreaterThan(0);

      const evidence = yield* json(base, `/evidence?model=${model}`).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Evidence))
      );

      expect(evidence.usage).toHaveLength(1);

      const counters = evidence.usage.flatMap((entry) =>
        Object.values(entry.record.models)
      );

      expect(counters).toHaveLength(1);
      expect(counters[0]?.totalTokens).toBeGreaterThan(0);
      expect(counters[0]?.output).toBeGreaterThan(0);

      const bundleBytes = (yield* io(() =>
        stat(path.join(directory, "worker.js"))
      )).size;

      yield* Effect.sync(() => {
        process.stdout.write(
          `model gateway proof: gpt-6-sol, low thinking, done; assistant text non-empty; recorded usage ${JSON.stringify(counters)}; bundle ${bundleBytes} bytes; endpoint/key [REDACTED]\n`
        );
      });

      return counters;
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.fail(new ProofFailure({ reason: redact(Cause.pretty(cause)) }))
      )
    );
  });

const missingInputs =
  binary === undefined ||
  binary === "" ||
  !readable(keyFile) ||
  !readable(endpointFile);

it.live.skipIf(missingInputs)(
  "celld DO settles one real model gateway model turn and records usage",
  () => realProof("gpt-6-sol"),
  90_000
);

it.live.skipIf(
  missingInputs || process.env.RAT_KING_MODEL_GATEWAY_OPUS_PROOF !== "1"
)(
  "celld Opus native messages request records its observed outcome",
  () => realProof("claude-opus-5-5"),
  90_000
);
