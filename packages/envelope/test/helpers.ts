/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import * as Defs from "@rat-king/lexicon/defs";
import { Effect, Schema } from "effect";

import { cryptoOperation, hpke, seal, suite } from "../src/envelope.ts";

export const senderDid = "did:web:sender.example";

export const recipientDid = "did:web:recipient.example";

export const testKeys = Effect.fn("Test.keys")(function* testKeys() {
  const sender = yield* cryptoOperation(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
  );

  const recipient = yield* cryptoOperation(() => hpke.kem.generateKeyPair());

  const signing = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      privateKey: Schema.instanceOf(CryptoKey),
      publicKey: Schema.instanceOf(CryptoKey),
    })
  )(sender);

  return { recipient, sender: signing };
});

export const payload = (messageId = "3m7x2ka4xv22a") =>
  Schema.decodeUnknownSync(Schema.toType(Defs.SigningPayload))({
    aad: {
      expiresAt: "2099-01-01T00:00:00Z",
      future: "bound",
      messageId,
      recipientDid,
      recipientKeyId: `${recipientDid}#encryption`,
      senderDid,
    },
    body: new TextEncoder().encode("hello"),
    suite,
    version: 1,
  });

export const sealed = Effect.fn("Test.sealed")(function* sealed() {
  const keys = yield* testKeys();

  const envelope = yield* seal({
    payload: payload(),
    recipientKey: keys.recipient.publicKey,
    recipientKeyId: `${recipientDid}#encryption`,
    signingKey: keys.sender.privateKey,
    signingKeyId: `${senderDid}#atproto`,
  });

  return { envelope, keys };
});
