// @effect-diagnostics nodeBuiltinImport:off -- Test-owned secret-store daemon and OS temporary store.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node process/filesystem adapters. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Identity } from "@rat-king/mailbox-client";
import { Arbitrary, Effect, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { stop } from "../../../../packages/agent-runtime/test/celld-process.ts";
import { provisionAgent } from "../register.ts";
import { SecretStore, secretCommand, secretStoreLayer } from "../secrets.ts";
import { io, identity, document } from "./helpers.ts";

const Agent = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,15}$/u));

const Did = Schema.String.check(
  Schema.isPattern(/^did:web:[a-z]{1,12}\.example\.invalid$/u)
);

it.live.prop(
  "provision reuses both keys, refuses DID changes without mutation, and emits only public JWKs",
  {
    agent: Arbitrary.schema(Agent),
    did: Arbitrary.schema(Did),
  },
  ({ agent, did }) =>
    Effect.gen(function* provisioning() {
      const directory = yield* io(() =>
        mkdtemp(path.join(tmpdir(), "rk-secrets-"))
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

      yield* Effect.callback<boolean>((resume) => {
        const ready = (chunk: Buffer) => {
          if (/Daemon running/u.test(chunk.toString())) {
            resume(Effect.succeed(true));
          }
        };

        child.stdout.on("data", ready);
        child.stderr.on("data", ready);

        return Effect.sync(() => {
          child.stdout.off("data", ready);
          child.stderr.off("data", ready);
        });
      }).pipe(Effect.timeout("5 seconds"));
      const operator = yield* identity("did:web:operator.example.invalid");
      const operatorDoc = yield* document(operator);
      const storeLayer = secretStoreLayer({ config, socket });

      const run = Effect.gen(function* claims() {
        const store = yield* SecretStore;
        yield* store.add("operator", JSON.stringify(operator));
        let registered = "";
        let conflict = false;

        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (!Predicate.isTagged(request.body, "Uint8Array")) {
              throw new Error("Expected JSON request");
            }

            const body = new TextDecoder().decode(request.body.body);

            if (conflict || (registered !== "" && body !== registered)) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  { error: "DocumentConflict" },
                  {
                    status: 409,
                  }
                )
              );
            }

            registered = body;

            return HttpClientResponse.fromWeb(
              request,
              Response.json({ did }, { status: 200 })
            );
          })
        );

        const input = {
          agent,
          did,
          documents: [operatorDoc],
          endpoint: "https://mailbox.example.invalid",
          operatorSecret: "operator",
          serviceDid: "did:web:service.example",
        };

        const first = yield* provisionAgent(input).pipe(
          Effect.provideService(HttpClient.HttpClient, http)
        );

        const original = yield* store.lease(first.secret);

        const second = yield* provisionAgent(input).pipe(
          Effect.provideService(HttpClient.HttpClient, http)
        );

        expect(second).toEqual(first);
        conflict = true;

        const conflicted = yield* provisionAgent(input).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.result
        );

        expect(Result.isFailure(conflicted)).toBe(true);

        if (Result.isFailure(conflicted)) {
          expect(conflicted.failure).toMatchObject({
            error: "DocumentConflict",
            status: 409,
          });
        }

        conflict = false;
        expect(yield* store.lease(first.secret)).toBe(original);

        const refused = yield* provisionAgent({
          ...input,
          did: `${did}:different`,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.result
        );

        expect(Result.isFailure(refused)).toBe(true);
        expect(yield* store.lease(first.secret)).toBe(original);
        expect(JSON.stringify(first)).not.toContain('"d":');
        expect(JSON.stringify(first)).not.toContain("privateKey");
        expect(Schema.is(Identity)(JSON.parse(original))).toBe(true);
      });

      yield* run.pipe(Effect.provide(storeLayer));
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 5 } }
);
