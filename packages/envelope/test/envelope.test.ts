/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import {
  aadBytes,
  canonical,
  canonicalDecode,
  cryptoOperation,
  hpke,
  info,
  lowS,
  open,
  p256Order,
  sign,
  signingBytes,
  suite,
} from "../src/envelope.ts";
import {
  payload,
  recipientDid,
  sealed,
  senderDid,
  testKeys,
} from "./helpers.ts";

const flip = (bytes: Uint8Array) =>
  Uint8Array.from(bytes, (byte, index) => {
    if (index !== 0) {
      return byte;
    }

    return byte % 2 === 0 ? byte + 1 : byte - 1;
  });

const alteredAad = (field: string) => {
  if (field === "messageId") {
    return "3m7x2ka4xv22b";
  }

  if (field === "expiresAt") {
    return "2098-01-01T00:00:00Z";
  }

  if (field === "senderDid" || field === "recipientDid") {
    return "did:web:wrong.example";
  }

  return "changed";
};

const requestFor = (sample: Effect.Success<ReturnType<typeof sealed>>) => ({
  envelope: sample.envelope,
  recipientDid,
  recipientKey: sample.keys.recipient.privateKey,
  recipientKeyId: `${recipientDid}#encryption`,
  resolveSigningKey: () => Effect.succeed(sample.keys.sender.publicKey),
});

it.effect(
  "seal/open and canonical bytes remain stable with future AAD fields",
  () =>
    Effect.gen(function* step1() {
      const sample = yield* sealed();
      const decoded = yield* open(requestFor(sample));
      expect(decoded).toEqual(payload());
      expect(
        canonical(yield* canonicalDecode(canonical(sample.envelope)))
      ).toEqual(canonical(sample.envelope));
    })
);

it.effect(
  "every outer metadata field, suite, enc and ciphertext tampering rejects",
  () =>
    Effect.gen(function* step2() {
      const sample = yield* sealed();

      const mutations = [
        { ...sample.envelope, version: 2 },
        ...["kemId", "kdfId", "aeadId"].map((field) => ({
          ...sample.envelope,
          suite: { ...suite, [field]: 2 },
        })),
        { ...sample.envelope, enc: flip(sample.envelope.enc) },
        { ...sample.envelope, ciphertext: flip(sample.envelope.ciphertext) },
        ...Object.keys(sample.envelope.aad).map((field) => ({
          ...sample.envelope,
          aad: {
            ...sample.envelope.aad,
            [field]: alteredAad(field),
          },
        })),
      ];

      for (const envelope of mutations) {
        const result = yield* open({ ...requestFor(sample), envelope }).pipe(
          Effect.exit
        );

        expect(result._tag).toBe("Failure");
      }

      const wrong = yield* cryptoOperation(() => hpke.kem.generateKeyPair());

      expect(
        (yield* open({
          ...requestFor(sample),
          recipientKey: wrong.privateKey,
        }).pipe(Effect.exit))._tag
      ).toBe("Failure");
      expect(
        (yield* open({
          ...requestFor(sample),
          recipientDid: "did:web:wrong.example",
        }).pipe(Effect.exit))._tag
      ).toBe("Failure");
    })
);

it.effect(
  "low-S is enforced; signature bytes, algorithm and inner metadata cannot be substituted",
  () =>
    Effect.gen(function* step3() {
      const keys = yield* testKeys();
      const original = payload();
      const bytes = signingBytes(original);
      const signature = yield* sign(keys.sender.privateKey, bytes);
      expect(signature.length).toBe(64);
      expect(lowS(signature)).toBe(true);

      const s = BigInt(
        `0x${Array.from(signature.subarray(32), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
      );

      const high = new Uint8Array(signature);
      high.set(
        Uint8Array.from(
          (p256Order - s).toString(16).padStart(64, "0").match(/../gu) ?? [],
          (pair) => Number.parseInt(pair, 16)
        ),
        32
      );
      expect(lowS(high)).toBe(false);

      const mismatch = {
        ...original,
        aad: { ...original.aad, senderDid: original.aad.recipientDid },
      };

      const variants = [
        {
          appSignature: {
            algorithm: "ES256",
            keyId: `${senderDid}#atproto`,
            signature: high,
          },
          canonicalSigningBytes: bytes,
        },
        {
          appSignature: {
            algorithm: "ES256",
            keyId: `${senderDid}#atproto`,
            signature: flip(signature),
          },
          canonicalSigningBytes: bytes,
        },
        {
          appSignature: {
            algorithm: "ES256",
            keyId: `${senderDid}#atproto`,
            signature,
          },
          canonicalSigningBytes: signingBytes({
            ...original,
            body: new TextEncoder().encode("different"),
          }),
        },
        {
          appSignature: {
            algorithm: "ES256",
            keyId: `${senderDid}#atproto`,
            signature: yield* sign(
              keys.sender.privateKey,
              signingBytes(mismatch)
            ),
          },
          canonicalSigningBytes: signingBytes(mismatch),
        },
        {
          appSignature: {
            algorithm: "ES256K",
            keyId: `${senderDid}#atproto`,
            signature,
          },
          canonicalSigningBytes: bytes,
        },
        {
          appSignature: {
            algorithm: "ES256",
            keyId: "did:web:other.example#atproto",
            signature,
          },
          canonicalSigningBytes: bytes,
        },
        {
          appSignature: {
            algorithm: "ES256",
            keyId: `${senderDid}#atproto`,
            signature,
          },
          canonicalSigningBytes: flip(bytes),
        },
      ];

      for (const signed of variants) {
        const context = yield* cryptoOperation(() =>
          hpke.createSenderContext({
            info,
            recipientPublicKey: keys.recipient.publicKey,
          })
        );

        const header = {
          aad: original.aad,
          enc: new Uint8Array(context.enc),
          suite,
          version: 1,
        };

        const ciphertext = yield* cryptoOperation(() =>
          context.seal(canonical(signed), aadBytes(header))
        );

        const result = yield* open({
          envelope: { ...header, ciphertext: new Uint8Array(ciphertext) },
          recipientDid,
          recipientKey: keys.recipient.privateKey,
          recipientKeyId: `${recipientDid}#encryption`,
          resolveSigningKey: () => Effect.succeed(keys.sender.publicKey),
        }).pipe(Effect.exit);

        expect(result._tag).toBe("Failure");
      }
    })
);
