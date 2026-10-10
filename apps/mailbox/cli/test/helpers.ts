// @effect-diagnostics nodeBuiltinImport:off -- Owned test processes and temporary public configuration.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node test I/O. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as Defs from "@rat-king/lexicon/defs";
import { Identity } from "@rat-king/mailbox-client";
import { Effect, Schema } from "effect";

import {
  freePort,
  stop,
} from "../../../../packages/agent-runtime/test/celld-process.ts";
import { configuration } from "../../src/bindings.ts";
import { generateKey, publicDocument } from "../provision.ts";

class TestFailure extends Schema.TaggedError<TestFailure>()(
  "ClientTestFailure",
  { reason: Schema.String }
) {}

export const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => new TestFailure({ reason: "Client test I/O failed" }),
    try: run,
  });

export const identity = (did: string) =>
  Effect.gen(function* createIdentity() {
    return yield* Schema.decodeUnknownEffect(Identity)({
      agreement: yield* generateKey("ECDH"),
      did,
      signing: yield* generateKey("ECDSA"),
    });
  });

export const document = (value: typeof Identity.Type) =>
  Schema.decodeUnknownEffect(Schema.toType(Defs.DidDocument))(
    publicDocument(value)
  );

export const celldNode = (
  binary: string,
  documentsJson: string,
  operatorDid: string
) =>
  Effect.gen(function* launchNode() {
    const directory = yield* io(() =>
      mkdtemp(path.join(tmpdir(), "rat-king-client-"))
    );

    yield* io(() =>
      writeFile(
        path.join(directory, "worker.ts"),
        `export { default, Mailbox, AuthTokens, Issuer } from ${JSON.stringify(path.resolve("apps/mailbox/test/worker.ts"))};`
      )
    );

    const config = configuration("worker.ts", {
      commit: "client-proof",
      documents: documentsJson,
      serviceDid: "did:web:service.example",
      version: "0.1.0-proof",
    });

    yield* io(() =>
      writeFile(
        path.join(directory, "wrangler.json"),
        JSON.stringify({
          ...config,
          vars: {
            ...config.vars,
            OPERATOR_DIDS: JSON.stringify([operatorDid]),
          },
        })
      )
    );
    const port = yield* freePort;

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
                "apps/mailbox/node_modules/.bin/esbuild"
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

    yield* Effect.callback<boolean, TestFailure>((resume) => {
      let output = "";

      const onOutput = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);

        if (output.includes("ready  http://")) {
          resume(Effect.succeed(true));
        }
      };

      const onError = () => {
        resume(Effect.fail(new TestFailure({ reason: "celld unavailable" })));
      };

      const onExit = () => {
        resume(
          Effect.fail(
            new TestFailure({ reason: "celld exited before readiness" })
          )
        );
      };

      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);
      child.once("error", onError);
      child.once("exit", onExit);

      return Effect.sync(() => {
        child.stdout.off("data", onOutput);
        child.stderr.off("data", onOutput);
        child.off("error", onError);
        child.off("exit", onExit);
      });
    }).pipe(Effect.timeout("20 seconds"));

    return `http://127.0.0.1:${port}`;
  });
