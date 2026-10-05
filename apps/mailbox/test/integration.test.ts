/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Effect owns control flow; Node process and HTTP adapters return SDK promises. */
// @effect-diagnostics globalFetch:off -- This is the base-URL HTTP test adapter and signed-out ingress probe, not application transport policy.
// @effect-diagnostics nodeBuiltinImport:off -- Integration harness starts its owned celld process and writes generated test configuration to an OS temp directory.
import { it } from "@effect/vitest";
import {
  canonical,
  canonicalDecode,
  cryptoOperation,
  open,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClient } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Acquire from "@rat-king/lexicon/runtime.acquireLease";
import * as Release from "@rat-king/lexicon/runtime.releaseLease";
import { Clock, DateTime, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";

import {
  payload,
  recipientDid,
  sealed,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { io, celldNode, TestFailure } from "./celld.ts";
import { documents } from "./helpers.ts";
import { httpClient } from "./http-client.ts";

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

    const acquire = (ttl = 60_000) =>
      Effect.gen(function* acquireLease() {
        return (yield* recipient.acquireLease(
          yield* Schema.decodeUnknownEffect(Acquire.Input)({
            did: recipientDid,
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + ttl)
            ),
            harness: {
              $type: "sh.mschf.ratking.runtime.lease#pi",
              sessionId: "integration",
            },
          })
        )).lease;
      });

    const lease = yield* acquire();

    const ack = yield* Schema.decodeUnknownEffect(Ack.Input)({
      generation: lease.generation,
      leaseId: lease.leaseId,
      message: first.receipt.message,
      recipientDid,
    });

    expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe("Failure");
    yield* recipient.deliver(
      yield* Schema.decodeUnknownEffect(Deliver.Input)(ack)
    );
    const page1 = yield* recipient.list(params);
    expect(page1.throughSeq).toBe(3);

    yield* recipient.releaseLease(
      yield* Schema.decodeUnknownEffect(Release.Input)({
        did: recipientDid,
        generation: lease.generation,
        leaseId: lease.leaseId,
      })
    );
    const rebound = yield* acquire();

    expect((yield* recipient.ack(ack).pipe(Effect.exit))._tag).toBe("Failure");

    const valid = {
      ...ack,
      generation: rebound.generation,
      leaseId: rebound.leaseId,
    };

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

    yield* recipient.releaseLease(
      yield* Schema.decodeUnknownEffect(Release.Input)({
        did: recipientDid,
        generation: rebound.generation,
        leaseId: rebound.leaseId,
      })
    );
    const expired = yield* acquire(200);
    yield* Clock.currentTimeMillis.pipe(
      Effect.filterOrFail(
        (now) => now > Date.parse(expired.expiresAt),
        () => new TestFailure({ message: "Expiry pending" })
      ),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 })
    );
    expect(
      (yield* recipient
        .ack({
          ...ack,
          generation: expired.generation,
          leaseId: expired.leaseId,
        })
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
