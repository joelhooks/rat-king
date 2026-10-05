import { expect, it } from "@effect/vitest";
import { encode } from "@ipld/dag-cbor";
import * as Defs from "@rat-king/lexicon/defs";
import { Arbitrary, Effect, Result, Schema } from "effect";

import { signingBytes } from "../src/canonical.ts";
import { sign, verify } from "../src/es256.ts";
import { testKeys } from "./helpers.ts";

const did = Schema.Literals([
  "did:web:sender.example.invalid",
  "did:web:recipient.example.invalid",
]);

const tid = Schema.Literals(["3jzfcijpj2z2a", "3jzfcijpj2z2b"]);

const date = Schema.Literals([
  "2026-10-05T00:00:00Z",
  "2026-10-05T00:00:00+00:00",
]);

const messageRef = Schema.Struct({ messageId: tid, senderDid: did });

const legacyPayloads = Arbitrary.schema(
  Schema.Struct({
    aad: Schema.Struct({
      expiresAt: Schema.optionalKey(date),
      future: Schema.optionalKey(Schema.String),
      messageId: tid,
      recipientDid: did,
      recipientKeyId: Schema.Literals([
        "did:web:recipient.example.invalid#encryption",
      ]),
      senderDid: did,
    }),
    body: Schema.Uint8Array,
    createdAt: Schema.optionalKey(date),
    replyTo: Schema.optionalKey(messageRef),
    suite: Defs.HpkeSuite.schema,
    version: Defs.SigningPayload.schema.fields.version,
  })
);

it.effect.prop(
  "every existing-shape payload keeps its pre-urgent signing bytes and signature verification",
  { original: legacyPayloads },
  ({ original }) =>
    Effect.gen(function* compatibility() {
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SigningPayload)
      )(original);

      const domain = new TextEncoder().encode(
        "sh.mschf.ratking.signature.v1\0"
      );

      const cbor = encode(original);
      const before = new Uint8Array(domain.length + cbor.length);
      before.set(domain);
      before.set(cbor, domain.length);
      const after = signingBytes(payload);
      expect(after).toEqual(before);
      expect(payload).toEqual(original);

      const keys = yield* testKeys();
      const oldSignature = yield* sign(keys.sender.privateKey, before);
      expect(yield* verify(keys.sender.publicKey, after, oldSignature)).toBe(
        true
      );
      const newSignature = yield* sign(keys.sender.privateKey, after);
      expect(yield* verify(keys.sender.publicKey, before, newSignature)).toBe(
        true
      );
    })
);

it.effect.prop(
  "urgent has only absent or true encodings and is bound by the signature",
  { original: legacyPayloads },
  ({ original }) =>
    Effect.gen(function* urgency() {
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SigningPayload)
      )(original);

      const urgent = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SigningPayload)
      )({ ...payload, urgent: true });

      const bytes = signingBytes(urgent);
      expect(bytes).not.toEqual(signingBytes(payload));
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Schema.toType(Defs.SigningPayload))(
            {
              ...payload,
              urgent: false,
            }
          ).pipe(Effect.result)
        )
      ).toBe(true);

      const keys = yield* testKeys();
      const signature = yield* sign(keys.sender.privateKey, bytes);
      expect(yield* verify(keys.sender.publicKey, bytes, signature)).toBe(true);
      expect(
        yield* verify(keys.sender.publicKey, signingBytes(payload), signature)
      ).toBe(false);
    })
);
