/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- WebCrypto test boundary. */
import { it } from "@effect/vitest";
import { seal, suite, cryptoOperation } from "@rat-king/envelope";
import * as Defs from "@rat-king/lexicon/defs";
import * as List from "@rat-king/lexicon/mailbox.list";
import { RatKingMailbox, layer, Identity, tid } from "@rat-king/mailbox-client";
import { Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import {
  testKeys,
  senderDid,
  recipientDid,
} from "../../../packages/envelope/test/helpers.ts";
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

      const publicDocuments = yield* Schema.decodeUnknownEffect(
        Schema.toType(Schema.Array(Defs.DidDocument))
      )(yield* documents(pair.sender.publicKey, pair.recipient.publicKey));

      const client = yield* RatKingMailbox.pipe(
        Effect.provide(
          layer({
            documents: publicDocuments,
            endpoint: "https://mailbox.example.invalid",
            identity,
            serviceDid: "did:web:service.example",
          }).pipe(Layer.provide(FetchHttpClient.layer))
        )
      );

      const result = yield* client.open(
        yield* Schema.decodeEffect(Defs.EncryptedEnvelope)(wire)
      );

      expect(result).toEqual({
        body: "proof message",
        encrypted: true,
        senderDid,
        tid: payload.aad.messageId,
        verified: true,
      });
      expect(
        Result.isFailure(
          yield* Schema.decodeEffect(Defs.EncryptedEnvelope)({
            ...wire,
            aad: { ...wire.aad, messageId: tid(1_700_000_000_001, 42) },
          }).pipe(Effect.flatMap(client.open), Effect.result)
        )
      ).toBe(true);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.toType(List.Params))({
          recipientDid,
        })
      ).toHaveProperty("recipientDid", recipientDid);
    })
);
