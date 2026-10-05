/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- WebCrypto test boundary. */
import { it } from "@effect/vitest";
import { seal, suite, cryptoOperation } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import {
  testKeys,
  senderDid,
  recipientDid,
} from "../../../packages/envelope/test/helpers.ts";
import { Identity } from "../cli/identity.ts";
import { open, tid } from "../cli/operations.ts";
import { staticResolver } from "../src/auth.ts";
import { documents } from "./helpers.ts";

it.effect(
  "CLI opens wire envelopes, verifies ES256 and refuses bound-metadata tampering",
  () =>
    Effect.gen(function* verifiedOpen() {
      const pair = yield* testKeys();

      const identity = yield* Schema.decodeUnknownEffect(Identity)({
        agreement: yield* cryptoOperation(() =>
          crypto.subtle.exportKey("jwk", pair.recipient.privateKey)
        ),
        did: recipientDid,
        signing: yield* cryptoOperation(() =>
          crypto.subtle.exportKey("jwk", pair.sender.privateKey)
        ),
      });

      const payload = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.SigningPayload)
      )({
        aad: {
          messageId: tid(1_700_000_000_000, 42),
          recipientDid,
          recipientKeyId: `${recipientDid}#encryption`,
          senderDid,
        },
        body: new TextEncoder().encode("proof message"),
        suite,
        version: 1,
      });

      const envelope = yield* seal({
        payload,
        recipientKey: pair.recipient.publicKey,
        recipientKeyId: payload.aad.recipientKeyId,
        signingKey: pair.sender.privateKey,
        signingKeyId: `${senderDid}#atproto`,
      });

      const wire = yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(envelope);

      const resolver = staticResolver(
        yield* documents(pair.sender.publicKey, pair.recipient.publicKey)
      );

      const result = yield* open(identity, wire).pipe(Effect.provide(resolver));
      expect(result).toEqual({
        body: "proof message",
        senderDid,
        tid: payload.aad.messageId,
        verified: true,
      });
      expect(
        Result.isFailure(
          yield* open(identity, {
            ...wire,
            aad: { ...wire.aad, messageId: tid(1_700_000_000_001, 42) },
          }).pipe(Effect.provide(resolver), Effect.result)
        )
      ).toBe(true);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.toType(List.Params))({
          recipientDid,
        })
      ).toHaveProperty("recipientDid", recipientDid);
    })
);
