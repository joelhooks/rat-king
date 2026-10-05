// @effect-diagnostics nodeBuiltinImport:off -- Test-owned daemon, PATH discovery and temporary encrypted store.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node process/filesystem adapters. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";

import { stop } from "../../../../packages/agent-runtime/test/celld-process.ts";
import { CliError } from "../identity.ts";
import { SecretStore, secretCommand, secretStoreLayer } from "../secrets.ts";
import { io } from "./helpers.ts";

export const secretsBinaryAbsentFromPath = !(process.env.PATH ?? "")
  .split(path.delimiter)
  .some((directory) => existsSync(path.join(directory, "secrets")));

export const memorySecretStoreLayer = Layer.sync(SecretStore, () => {
  const entries = new Map<string, string>();

  return SecretStore.of({
    add: Effect.fn("SecretStore.Test.add")((name, value) =>
      Effect.suspend(() => {
        if (entries.has(name)) {
          return Effect.fail(new CliError({ reason: "Secret already exists" }));
        }

        entries.set(name, value);

        return Effect.void;
      })
    ),
    exists: Effect.fn("SecretStore.Test.exists")((name) =>
      Effect.sync(() => entries.has(name))
    ),
    lease: Effect.fn("SecretStore.Test.lease")((name) =>
      Effect.suspend(() => {
        const value = entries.get(name);

        return value === undefined
          ? Effect.fail(new CliError({ reason: "Secret not found" }))
          : Effect.succeed(value);
      })
    ),
  });
});

export const isolatedSecretStoreLayer = Effect.gen(function* isolatedStore() {
  const directory = yield* Effect.acquireRelease(
    io(() => mkdtemp(path.join(tmpdir(), "rk-secrets-"))),
    (owned) =>
      io(() => rm(owned, { force: true, recursive: true })).pipe(Effect.orDie)
  );

  const socket = path.join(directory, "store.sock");
  const config = path.join(directory, "config.json");
  yield* io(() =>
    writeFile(
      config,
      JSON.stringify({
        audit_path: path.join(directory, "audit.jsonl"),
        default_lease_ttl: 60_000_000_000,
        directory,
        identity_path: path.join(directory, "identity.txt"),
        leases_path: path.join(directory, "leases.json"),
        max_lease_ttl: 3_600_000_000_000,
        rotation_timeout: 30_000_000_000,
        secrets_path: path.join(directory, "secrets.age"),
        socket_mode: "0600",
        socket_path: socket,
      }),
      { mode: 0o600 }
    )
  );
  yield* secretCommand(["--config", config, "init"]);

  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn("secrets", ["--no-update-check", "--config", config, "serve"], {
        stdio: ["ignore", "pipe", "pipe"],
      })
    ),
    (owned) =>
      stop(owned, "SIGTERM").pipe(Effect.timeout("5 seconds"), Effect.orDie)
  );

  yield* Effect.callback<boolean, CliError>((resume) => {
    let output = "";

    const ready = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);

      if (output.includes("Daemon running")) {
        resume(Effect.succeed(true));
      }
    };

    const unavailable = () => {
      resume(
        Effect.fail(
          new CliError({ reason: "Test secret-store daemon unavailable" })
        )
      );
    };

    const exited = () => {
      resume(
        Effect.fail(
          new CliError({
            reason: "Test secret-store daemon exited before readiness",
          })
        )
      );
    };

    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
    child.once("error", unavailable);
    child.once("exit", exited);

    return Effect.sync(() => {
      child.stdout.off("data", ready);
      child.stderr.off("data", ready);
      child.off("error", unavailable);
      child.off("exit", exited);
    });
  }).pipe(Effect.timeout("5 seconds"));

  return secretStoreLayer({ config, socket });
});
