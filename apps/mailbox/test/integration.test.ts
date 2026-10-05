/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Effect owns control flow; Node process and HTTP adapters return SDK promises. */
// @effect-diagnostics globalFetch:off -- This is the base-URL HTTP test adapter and signed-out ingress probe, not application transport policy.
// @effect-diagnostics nodeBuiltinImport:off -- Integration harness starts its owned celld process and writes generated test configuration to an OS temp directory.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import {
  canonical,
  canonicalDecode,
  cryptoOperation,
  open,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { clientLayer, MailboxClient } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import type {
  Request as XrpcRequest,
  Response as XrpcResponse,
} from "@rat-king/lexicon/transport";
import { TransportFailure } from "@rat-king/lexicon/transport-failure";
import { Clock, Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import {
  payload,
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { base64url, serviceToken } from "../src/auth.ts";
import { configuration } from "../src/bindings.ts";
import { Lease } from "../src/store.ts";
import { documents } from "./helpers.ts";

class TestFailure extends Schema.TaggedError<TestFailure>()("TestFailure", {
  message: Schema.String,
}) {}

const io = <A>(operation: () => Promise<A>) =>
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

const celldNode = (binary: string, documentsJson: string) =>
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

export const httpClient = (baseUrl: string, issuer: string, key: CryptoKey) =>
  clientLayer.pipe(
    Layer.provide(
      Layer.succeed(Transport, {
        request: Effect.fn("Test.httpTransport")(
          function* request(input: XrpcRequest) {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

            const token = yield* serviceToken(
              {
                aud: "did:web:service.example#mailbox",
                exp: now + 60,
                iat: now,
                iss: issuer,
                jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
                lxm: input.nsid,
              },
              key
            );

            const url = new URL(`/xrpc/${input.nsid}`, baseUrl);

            const params = yield* Schema.decodeUnknownEffect(
              Schema.Record(
                Schema.String,
                Schema.Union([Schema.String, Schema.Int])
              )
            )(input.params ?? {});

            for (const [name, value] of Object.entries(params)) {
              url.searchParams.set(name, String(value));
            }

            const options: RequestInit = {
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              method: input.method,
            };

            if (input.input !== undefined) {
              options.body = JSON.stringify(input.input);
            }

            const response = yield* io(() => fetch(url, options));

            const body = yield* Schema.decodeUnknownEffect(
              Schema.toEncoded(Runtime.Data)
            )(yield* io(() => response.json()));

            return {
              body,
              kind: "json",
              status: response.status,
            } satisfies XrpcResponse;
          },
          Effect.mapError(
            () =>
              new TransportFailure({
                cause: undefined,
                reason: "HTTP transport failed",
              })
          )
        ),
      })
    )
  );

export const outcomeProof = (
  baseUrl: string,
  sample: Effect.Success<ReturnType<typeof sealed>>
) =>
  Effect.gen(function* outcome() {
    const sender = yield* Effect.gen(function* senderService() {
      return yield* MailboxClient;
    }).pipe(
      Effect.provide(
        httpClient(baseUrl, senderDid, sample.keys.sender.privateKey)
      )
    );

    const recipient = yield* Effect.gen(function* recipientService() {
      return yield* MailboxClient;
    }).pipe(
      Effect.provide(
        httpClient(baseUrl, recipientDid, sample.keys.sender.privateKey)
      )
    );

    const version = yield* io(() =>
      fetch(`${baseUrl}/.well-known/rat-king/version`)
    );

    expect(yield* io(() => version.json())).toEqual({
      commit: "b845798-proof",
      version: "0.1.0-proof",
    });
    const first = yield* sender.send({ envelope: sample.envelope });
    expect(first.receipt.seq).toBe(1);
    expect(yield* sender.send({ envelope: sample.envelope })).toEqual(first);
    expect(
      (yield* sender
        .send({
          envelope: { ...sample.envelope, ciphertext: new Uint8Array([1]) },
        })
        .pipe(Effect.exit))._tag
    ).toBe("Failure");
    expect(
      (yield* recipient.send({ envelope: sample.envelope }).pipe(Effect.exit))
        ._tag
    ).toBe("Failure");

    const openRequest = {
      envelope: sample.envelope,
      recipientDid,
      recipientKey: sample.keys.recipient.privateKey,
      recipientKeyId: `${recipientDid}#encryption`,
      resolveSigningKey: () => Effect.succeed(sample.keys.sender.publicKey),
    };

    expect((yield* open(openRequest)).body).toEqual(
      new TextEncoder().encode("hello")
    );
    expect(
      (yield* open({ ...openRequest, recipientDid: senderDid }).pipe(
        Effect.exit
      ))._tag
    ).toBe("Failure");
    expect(
      (yield* open({
        ...openRequest,
        envelope: {
          ...sample.envelope,
          aad: { ...sample.envelope.aad, future: "tampered" },
        },
      }).pipe(Effect.exit))._tag
    ).toBe("Failure");

    const params = yield* Schema.decodeUnknownEffect(List.Params)({
      limit: 1,
      recipientDid,
    });

    const initial = yield* recipient.list(params);
    expect(initial.throughSeq).toBe(1);

    const rpc = (operation: string, generation: number, ttl = 60_000) =>
      Effect.gen(function* rpcCall() {
        const result = yield* io(() =>
          fetch(`${baseUrl}/test/lease`, {
            body: JSON.stringify({
              generation,
              leaseId: "3m7x2ka4xv22b",
              messageId: sample.envelope.aad.messageId,
              operation,
              recipientDid,
              senderDid,
              ttl,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        );

        expect(result.status).toBe(200);

        return yield* io(() => result.json());
      });

    const lease = yield* Schema.decodeUnknownEffect(Lease)(
      yield* rpc("acquire", 0)
    );

    const ack = yield* Schema.decodeUnknownEffect(Ack.Input)({
      generation: lease.generation,
      leaseId: lease.leaseId,
      message: first.receipt.message,
      recipientDid,
    });

    expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe("Failure");
    yield* rpc("inject", lease.generation);
    const page1 = yield* recipient.list(params);
    expect(page1.throughSeq).toBe(3);

    const rebound = yield* Schema.decodeUnknownEffect(Lease)(
      yield* rpc("acquire", 0)
    );

    expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe("Failure");
    const valid = { ...ack, generation: rebound.generation };
    const acknowledged = yield* recipient.ack(valid);
    expect(acknowledged.receipt.state).toBe("acked");
    expect(yield* recipient.ack(valid)).toEqual(acknowledged);

    const page2 = yield* recipient.list({
      ...params,
      cursor: page1.cursor ?? "",
    });

    const page3 = yield* recipient.list({
      ...params,
      cursor: page2.cursor ?? "",
    });

    expect(page2.throughSeq).toBe(3);
    expect(page3.throughSeq).toBe(3);
    expect(page2.events[0]?.seq).toBe(2);
    expect(page3.events[0]?.seq).toBe(3);
    expect(page3.cursor).toBeUndefined();
    expect(
      (yield* recipient
        .list({ ...params, cursor: page1.cursor ?? "", limit: 2 })
        .pipe(Effect.exit))._tag
    ).toBe("Failure");
    const all = yield* recipient.list({ ...params, limit: 100 });
    expect(all.throughSeq).toBe(4);
    expect(all.events.length).toBe(4);

    const expired = yield* Schema.decodeUnknownEffect(Lease)(
      yield* rpc("acquire", 0, 1)
    );

    yield* Effect.sleep("10 millis");
    expect(
      (yield* recipient
        .ack({ ...ack, generation: expired.generation })
        .pipe(Effect.exit))._tag
    ).toBe("Failure");
    expect((yield* sender.list(params).pipe(Effect.exit))._tag).toBe("Failure");

    const noAuth = yield* io(() =>
      fetch(
        `${baseUrl}/xrpc/sh.mschf.ratking.mailbox.list?recipientDid=${encodeURIComponent(recipientDid)}`
      )
    );

    expect(noAuth.status).toBe(401);
  });

const exportBytes = (format: "pkcs8" | "spki", key: CryptoKey) =>
  cryptoOperation(() => crypto.subtle.exportKey(format, key)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.instanceOf(ArrayBuffer))),
    Effect.map((raw) => new Uint8Array(raw))
  );

const binary = process.env.RAT_KING_CELLD;

it.live.skipIf(binary === undefined)(
  "Node seals -> celld opens; celld seals -> Node opens (real HPKE)",
  () =>
    Effect.gen(function* hpkeIntegration() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const baseUrl = yield* celldNode(binary ?? "", JSON.stringify(docs));

      const body = canonical({
        envelope: sample.envelope,
        recipientPrivate: yield* exportBytes(
          "pkcs8",
          sample.keys.recipient.privateKey
        ),
        recipientPublic: yield* exportBytes(
          "spki",
          sample.keys.recipient.publicKey
        ),
        signingPrivate: yield* exportBytes(
          "pkcs8",
          sample.keys.sender.privateKey
        ),
        signingPublic: yield* exportBytes("spki", sample.keys.sender.publicKey),
      });

      const call = (operation: "open" | "seal") =>
        Effect.gen(function* probe() {
          const response = yield* io(() =>
            fetch(`${baseUrl}/test/hpke/${operation}`, {
              body,
              headers: { "content-type": "application/cbor" },
              method: "POST",
            })
          );

          if (response.status !== 200) {
            return yield* Effect.fail(
              new TestFailure({
                message: `${operation}: ${yield* io(() => response.text())}`,
              })
            );
          }

          return yield* canonicalDecode(
            new Uint8Array(yield* io(() => response.arrayBuffer()))
          );
        });

      const plaintext = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SigningPayload)
      )(yield* call("open"));

      expect(plaintext).toEqual(payload());

      const reply = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.EncryptedEnvelope)
      )(yield* call("seal"));

      expect(reply.enc.byteLength).toBe(65);

      const opened = yield* open({
        envelope: reply,
        recipientDid,
        recipientKey: sample.keys.recipient.privateKey,
        recipientKeyId: `${recipientDid}#encryption`,
        resolveSigningKey: () => Effect.succeed(sample.keys.sender.publicKey),
      });

      expect(opened).toEqual({
        ...payload(),
        body: new TextEncoder().encode("reply from celld"),
      });
    }).pipe(Effect.scoped)
);

it.live.skipIf(binary === undefined)(
  "recipient outcome against celld dev (same base-URL suite for P6)",
  () =>
    Effect.gen(function* integration() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const baseUrl = yield* celldNode(binary ?? "", JSON.stringify(docs));
      const rawProbe = yield* io(() => fetch(`${baseUrl}/test/p256-raw`));
      expect(yield* io(() => rawProbe.json())).toEqual({ rawLength: 91 });
      yield* outcomeProof(baseUrl, sample);
    }).pipe(Effect.scoped)
);
