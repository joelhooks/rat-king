/* oxlint-disable typescript/promise-function-async -- Effect owns lazy WebCrypto and HTTP Promise adapters. */
import {
  canonical,
  canonicalDecode,
  cryptoOperation,
  open,
  seal,
} from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";

export const HpkeProbe = Schema.Struct({
  envelope: Schema.toType(Defs.EncryptedEnvelope),
  recipientPrivate: Schema.Uint8Array,
  recipientPublic: Schema.Uint8Array,
  signingPrivate: Schema.Uint8Array,
  signingPublic: Schema.Uint8Array,
});

export const hpkeProof = Effect.fn("Test.workerHpke")(function* hpkeProof(
  request: Request
) {
  const command = yield* Schema.decodeUnknownEffect(HpkeProbe)(
    yield* canonicalDecode(
      new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
    )
  );

  const recipientKey = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "pkcs8",
      command.recipientPrivate,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    )
  );

  const signingPublic = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "spki",
      command.signingPublic,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    )
  );

  const payload = yield* open({
    envelope: command.envelope,
    recipientDid: command.envelope.aad.recipientDid,
    recipientKey,
    recipientKeyId: command.envelope.aad.recipientKeyId,
    resolveSigningKey: () => Effect.succeed(signingPublic),
  });

  if (new URL(request.url).pathname === "/test/hpke/open") {
    return new Response(canonical(payload));
  }

  const recipientPublic = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "spki",
      command.recipientPublic,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    )
  );

  const signingPrivate = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "pkcs8",
      command.signingPrivate,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    )
  );

  const reply = yield* seal({
    payload: { ...payload, body: new TextEncoder().encode("reply from celld") },
    recipientKey: recipientPublic,
    recipientKeyId: payload.aad.recipientKeyId,
    signingKey: signingPrivate,
    signingKeyId: `${payload.aad.senderDid}#atproto`,
  });

  return new Response(canonical(reply));
});
