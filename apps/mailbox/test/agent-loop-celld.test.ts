// @effect-diagnostics nodeBuiltinImport:off -- Owned loopback proof and ephemeral config.
// @effect-diagnostics asyncFunction:off -- File, esbuild, subprocess and HTTP adapters.
// @effect-diagnostics globalFetch:off -- Loopback proof transport only.
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy Node adapters. */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { clientLayer, MailboxClient } from "@rat-king/lexicon/mailbox-client";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import { Cause, Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { build } from "esbuild";
import { expect } from "vitest";

import {
  freePort,
  io,
  launch,
  ProofFailure,
  json,
} from "../../../packages/agent-runtime/test/celld-process.ts";
import { transportLayer } from "../cli/client.ts";
import { readIdentity } from "../cli/identity.ts";
import { provision } from "../cli/provision.ts";

const binary = process.env.RAT_KING_CELLD;

const keyFile = process.env.RAT_KING_MODEL_GATEWAY_KEY_FILE;

const endpointFile = process.env.RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE;

const faux = process.env.RAT_KING_MAILBOX_FAUX_PROOF === "1";

const readable = (file: string | undefined) => {
  try {
    if (file === undefined || file === "") {
      return false;
    }

    accessSync(file, constants.R_OK);

    return true;
  } catch {
    return false;
  }
};

// oxlint-disable-next-line typescript/strict-void-return -- Node execFile callback overload.
const execute = promisify(execFile);

const AgentEvidence = Schema.Struct({
  agent: Schema.Struct({
    completed: Schema.Array(Schema.Struct({ value: Schema.String })),
    drain: Schema.Array(Schema.Struct({ value: Schema.String })),
    journal: Schema.Array(
      Schema.Struct({ request_id: Schema.String, value: Schema.String })
    ),
    submissions: Schema.Array(Schema.Struct({ id: Schema.Int })),
  }),
  wakes: Schema.Array(
    Schema.Struct({
      outcome: Schema.String,
      sender: Schema.String,
      tid: Schema.String,
    })
  ),
});

const Opened = Schema.Struct({
  body: Schema.String,
  replyTo: Defs.MessageRef,
  senderDid: Schema.String,
  tid: Schema.String,
  verified: Schema.Boolean,
});

it.live.skipIf(
  binary === undefined ||
    binary === "" ||
    (!faux && (!readable(keyFile) || !readable(endpointFile)))
)(
  "celld hosted mailbox answers, verifies, acknowledges and deduplicates one question",
  () =>
    Effect.gen(function* proof() {
      if (binary === undefined || binary === "") {
        return yield* new ProofFailure({ reason: "Missing celld" });
      }

      const credential = faux
        ? ""
        : (yield* io(() => readFile(keyFile ?? "", "utf-8"))).trim();

      const endpoint = faux
        ? ""
        : (yield* io(() => readFile(endpointFile ?? "", "utf-8"))).trim();

      const gatewayHost = faux
        ? ""
        : yield* Effect.try({
            catch: () =>
              new ProofFailure({ reason: "Invalid gateway endpoint" }),
            try: () => new URL(endpoint).hostname,
          });

      const redact = (text: string) => {
        let result = text;

        for (const secret of [credential, endpoint, gatewayHost]) {
          if (secret) {
            result = result.replaceAll(secret, "[REDACTED]");
          }
        }

        return result;
      };

      return yield* Effect.gen(function* run() {
        const directory = yield* Effect.acquireRelease(
          io(() => mkdtemp(path.join(tmpdir(), "rat-king-mailbox-loop-"))),
          (owned) => io(() => execute("trash", [owned])).pipe(Effect.orDie)
        );

        const clientLabel =
          process.env.RAT_KING_MAILBOX_CLIENT_LABEL ?? "sender";

        const senderDid = "did:web:sender.example.invalid";
        const agentDid = "did:web:agent.example.invalid";
        const serviceDid = "did:web:mailbox.example.invalid";

        const documents = yield* Effect.gen(function* identities() {
          return [
            yield* provision(directory, clientLabel, senderDid),
            yield* provision(directory, "agent", agentDid),
          ];
        }).pipe(Effect.provide(NodeServices.layer));

        const agentIdentity = yield* readIdentity(directory, "agent").pipe(
          Effect.provide(NodeServices.layer)
        );

        const docsFile = path.join(directory, "documents.json");
        yield* io(() =>
          writeFile(docsFile, JSON.stringify(documents), { mode: 0o600 })
        );
        const worker = path.join(directory, "worker.js");
        yield* io(() =>
          build({
            bundle: true,
            define: {
              __BUNDLE_COMMIT__: JSON.stringify("local-proof"),
              __BUNDLE_VERSION__: JSON.stringify("s5-proof"),
            },
            entryPoints: [path.resolve("apps/mailbox/test/agent-worker.ts")],
            external: ["cloudflare:workers"],
            format: "esm",
            minify: true,
            outfile: worker,
            platform: "browser",
            target: "es2023",
          })
        );
        const cli = path.join(directory, "mailbox.mjs");
        yield* io(() =>
          build({
            banner: {
              js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
            },
            bundle: true,
            entryPoints: [path.resolve("apps/mailbox/cli/main.ts")],
            format: "esm",
            outfile: cli,
            platform: "node",
            target: "es2023",
          })
        );
        const config = path.join(directory, "wrangler.json");

        const vars = {
          AGENT_MODEL: faux ? "faux" : "gateway",
          DID_DOCUMENTS: JSON.stringify(documents),
          HOSTED_AGENTS: JSON.stringify([agentDid]),
          SERVICE_DID: serviceDid,
        };

        if (!faux) {
          Object.assign(vars, {
            MODEL_GATEWAY_BASE_URL: endpoint,
            MODEL_GATEWAY_MODEL: "gpt-6-sol",
          });
        }

        yield* io(() =>
          writeFile(
            config,
            JSON.stringify({
              compatibility_date: "2026-10-04",
              durable_objects: {
                bindings: [
                  { class_name: "Mailbox", name: "MAILBOX" },
                  { class_name: "AuthTokens", name: "AUTH_TOKENS" },
                  { class_name: "Agent", name: "AGENT" },
                ],
              },
              main: "worker.js",
              migrations: [
                {
                  new_sqlite_classes: ["Mailbox", "AuthTokens", "Agent"],
                  tag: "v1",
                },
              ],
              name: "mailbox-loop-proof",
              vars,
            }),
            { mode: 0o600 }
          )
        );
        const secrets = path.join(directory, ".dev.vars");
        yield* io(() =>
          writeFile(
            secrets,
            `AGENT_IDENTITIES_CREDENTIAL=${JSON.stringify([agentIdentity])}\n${
              faux
                ? ""
                : `MODEL_GATEWAY_CREDENTIAL=${JSON.stringify(credential)}\n`
            }`,
            { mode: 0o600 }
          )
        );
        expect((yield* io(() => stat(config))).mode % 512).toBe(0o600);
        expect((yield* io(() => stat(secrets))).mode % 512).toBe(0o600);

        const port = yield* freePort;
        yield* launch(binary, directory, port);
        const base = `http://127.0.0.1:${port}`;

        const cliEnv = {
          ...process.env,
          HOME: directory,
          RAT_KING_DOCUMENTS: docsFile,
          RAT_KING_ENDPOINT: base,
          RAT_KING_SERVICE_DID: serviceDid,
        };

        const command = (args: string[]) =>
          io(() =>
            execute(process.execPath, [cli, ...args], { env: cliEnv })
          ).pipe(
            Effect.map(({ stdout }) => stdout.trim()),
            Effect.mapError(
              (error) => new ProofFailure({ reason: redact(error.reason) })
            )
          );

        const listAs = (as: string) =>
          command(["list", "--as", as]).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(List.Output))
            )
          );

        const admitted = yield* command([
          "send",
          "--from",
          clientLabel,
          "--to",
          agentDid,
          "--body",
          "What is 2 + 2? Answer in one short line.",
        ]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Send.Output))
          )
        );

        expect(admitted.receipt.state).toBe("accepted");

        const waitForReply = Effect.gen(function* waitForReply() {
          const page = yield* listAs(clientLabel);
          const replies = page.events.filter(Schema.is(Defs.MessageEvent));

          if (replies.length !== 1) {
            return yield* new ProofFailure({ reason: "Reply not yet visible" });
          }

          return replies[0];
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 })
        );

        const reply = yield* waitForReply.pipe(
          Effect.tapError(() =>
            json(base, "/test/agent-evidence").pipe(
              Effect.tap((data) =>
                Effect.sync(() =>
                  process.stdout.write(
                    redact(`Loop evidence: ${JSON.stringify(data)}\n`)
                  )
                )
              )
            )
          )
        );

        if (!reply) {
          return yield* new ProofFailure({ reason: "Missing reply" });
        }

        const replyFile = path.join(directory, "reply.json");

        const replyWire = yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(
          reply.envelope
        );

        yield* io(() =>
          writeFile(replyFile, JSON.stringify(replyWire), { mode: 0o600 })
        );

        const opened = yield* command([
          "open",
          "--as",
          clientLabel,
          "--file",
          replyFile,
        ]).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Opened))
          )
        );

        expect(opened.verified).toBe(true);
        expect(opened.senderDid).toBe(agentDid);
        expect(opened.replyTo).toEqual(admitted.receipt.message);
        expect(opened.body.trim().length).toBeGreaterThan(0);

        const original = yield* Effect.gen(function* ackedInput() {
          const page = yield* listAs("agent");
          const receipts = page.events.filter(Schema.is(Defs.ReceiptEvent));

          if (!receipts.some((event) => event.receipt.state === "acked")) {
            return yield* new ProofFailure({
              reason: "Original not yet acknowledged",
            });
          }

          const message = page.events.find(Schema.is(Defs.MessageEvent));

          if (!message) {
            return yield* new ProofFailure({
              reason: "Missing original envelope",
            });
          }

          return message;
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 20 }),
          Effect.tapError(() =>
            json(base, "/test/agent-evidence").pipe(
              Effect.tap((data) =>
                Effect.sync(() =>
                  process.stdout.write(
                    redact(`Ack evidence: ${JSON.stringify(data)}\n`)
                  )
                )
              )
            )
          )
        );

        const clientIdentity = yield* readIdentity(directory, clientLabel).pipe(
          Effect.provide(NodeServices.layer)
        );

        const client = clientLayer.pipe(
          Layer.provide(
            transportLayer(base, `${serviceDid}#mailbox`, clientIdentity).pipe(
              Layer.provide(FetchHttpClient.layer)
            )
          )
        );

        const replay = yield* Effect.gen(function* replay() {
          return yield* (yield* MailboxClient).send({
            envelope: original.envelope,
          });
        }).pipe(Effect.provide(client));

        expect(replay).toEqual(admitted);

        const settledEvidence = yield* json(base, "/test/agent-evidence").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AgentEvidence)),
          Effect.filterOrFail(
            (data) =>
              data.wakes.length >= 2 &&
              data.agent.drain[0]?.value === "done" &&
              Number(data.agent.completed[0]?.value ?? "0") >= 2,
            () => new ProofFailure({ reason: "Duplicate wake not yet drained" })
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 20 })
        );

        yield* Effect.sleep("1 second");
        const after = yield* listAs(clientLabel);
        expect(after.events.filter(Schema.is(Defs.MessageEvent))).toHaveLength(
          1
        );

        const finalEvidence = yield* json(base, "/test/agent-evidence").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AgentEvidence))
        );

        expect(finalEvidence.agent.submissions).toHaveLength(1);
        expect(settledEvidence.agent.journal).toHaveLength(1);
        expect(
          settledEvidence.wakes.every((wake) => wake.outcome === "accepted")
        ).toBe(true);

        const checkpoint = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ _tag: Schema.Literal("acked") })
          )
        )(settledEvidence.agent.journal[0]?.value);

        expect(checkpoint._tag).toBe("acked");

        yield* Effect.sync(() =>
          process.stdout.write(
            redact(
              `S5 mailbox loop: mode=${faux ? "faux" : "gpt-6-sol low"}; endpoint/key [REDACTED]\n` +
                `send --from ${clientLabel}: ${JSON.stringify(admitted)}\n` +
                `open --as ${clientLabel}: ${JSON.stringify(opened)}\n` +
                "original=acked; duplicate receipt=original; reply count=1; submission count=1; wake receipts=2 accepted; tools/extensions=0\n"
            )
          )
        );

        return yield* Effect.void;
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.fail(new ProofFailure({ reason: redact(Cause.pretty(cause)) }))
        )
      );
    }),
  120_000
);
