/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy WebCrypto test adapters. */
import { it } from "@effect/vitest";
import { open } from "@rat-king/envelope";
import type * as Defs from "@rat-king/lexicon/defs";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  Arbitrary,
  Effect,
  Layer,
  Match,
  Predicate,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { importAgreement } from "../src/identity.ts";
import { prepare, ownIdentity, SendOutcomes } from "../src/prepare.ts";
import { document, identity } from "./identity.ts";

it.effect.prop(
  "CC failure cannot change primary; uncertain retry preserves ciphertext and receipt",
  [Arbitrary.schema(Schema.Literals([200, 409, 503]))],
  ([status]) =>
    Effect.gen(function* proof() {
      const sender = yield* identity("did:web:sender.invalid");
      const recipient = yield* identity("did:web:recipient.invalid");
      const phone = yield* identity("did:web:phone.invalid");
      const docs = yield* Effect.forEach([sender, recipient, phone], document);
      const primaryRequests: string[] = [];
      const ccRequests: Defs.EncryptedEnvelopeValue[] = [];

      const http = HttpClient.make((request) =>
        Effect.gen(function* respond() {
          if (!Predicate.isTagged(request.body, "Uint8Array")) {
            throw new Error("Expected JSON body");
          }

          const text = new TextDecoder().decode(request.body.body);

          const input = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Send.Input)
          )(text).pipe(Effect.orDie);

          const isCc = input.envelope.aad.recipientDid === phone.did;

          if (isCc) {
            ccRequests.push(input.envelope);
          } else {
            primaryRequests.push(text);
          }

          const receipt = {
            message: {
              messageId: input.envelope.aad.messageId,
              senderDid: sender.did,
            },
            recipientDid: input.envelope.aad.recipientDid,
            seq: 1,
            state: "accepted",
          };

          let responseStatus = isCc ? status : 200;

          if (!isCc && primaryRequests.length === 1) {
            responseStatus = 503;
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              responseStatus === 200 ? { receipt } : { error: "Conflict" },
              { status: responseStatus }
            )
          );
        })
      );

      const own = yield* ownIdentity(sender);

      const client = yield* prepare({
        endpoint: "https://mailbox.invalid",
        own,
        peers: docs,
        serviceDid: "did:web:service.invalid",
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));

      const envelope = yield* client.seal(recipient.did, "durable content");
      const uncertain = yield* client.send(envelope, { cc: phone.did });
      expect(uncertain._tag).toBe("Uncertain");
      expect(uncertain.cc?._tag).toBe("NotAttempted");
      const accepted = yield* client.send(envelope, { cc: phone.did });
      expect(accepted._tag).toBe("Accepted");
      expect(accepted.cc?._tag).toBe(
        Match.value(status).pipe(
          Match.when(200, () => "Accepted"),
          Match.when(409, () => "Rejected"),
          Match.orElse(() => "Uncertain")
        )
      );
      expect(primaryRequests[0]).toBe(primaryRequests[1]);
      const replay = yield* client.send(envelope);
      expect(replay).toEqual(
        Predicate.isTagged(accepted, "Accepted")
          ? SendOutcomes.Accepted({ receipt: accepted.receipt })
          : accepted
      );
      expect(ccRequests.length).toBe(1);
      const [copy] = ccRequests;

      const signingDoc = docs
        .find((value) => value.id === sender.did)
        ?.verificationMethod.find(
          (value) => value.id === `${sender.did}#atproto`
        );

      if (copy === undefined || signingDoc === undefined) {
        throw new Error("Missing CC or public signing key");
      }

      const publicKey = yield* Effect.tryPromise(() =>
        crypto.subtle.importKey(
          "jwk",
          signingDoc.publicKeyJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"]
        )
      ).pipe(Effect.orDie);

      const payload = yield* open({
        envelope: copy,
        recipientDid: phone.did,
        recipientKey: yield* importAgreement(phone),
        recipientKeyId: `${phone.did}#encryption`,
        resolveSigningKey: () => Effect.succeed(publicKey),
      });

      const body = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            $type: Schema.Literal("sh.mschf.ratking.mailbox.cc"),
            primary: Schema.Struct({ messageId: Schema.String }),
          })
        )
      )(new TextDecoder().decode(payload.body));

      expect(body.primary.messageId).toBe(envelope.aad.messageId);
      expect(copy.aad.messageId).not.toBe(envelope.aad.messageId);
      expect(payload.replyTo?.messageId).toBe(envelope.aad.messageId);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "unknown peer fails closed and directory conflict retains the trusted key",
  [Arbitrary.schema(Schema.Boolean)],
  ([conflict]) =>
    Effect.gen(function* proof() {
      const sender = yield* identity("did:web:sender.invalid");
      const recipient = yield* identity("did:web:recipient.invalid");
      const replacement = yield* identity(recipient.did);
      const docs = yield* Effect.forEach([sender, recipient], document);
      const remote = yield* document(conflict ? replacement : recipient);
      let calls = 0;

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls += 1;

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ document: remote })
          );
        })
      );

      const client = yield* prepare({
        endpoint: "https://mailbox.invalid",
        own: yield* ownIdentity(sender),
        peers: docs,
        serviceDid: "did:web:service.invalid",
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));

      expect(
        Result.isFailure(
          yield* client
            .seal("did:web:unknown.invalid", "body")
            .pipe(Effect.result)
        )
      ).toBe(true);
      expect(calls).toBe(0);
      expect(
        Result.isFailure(
          yield* client.refresh(recipient.did).pipe(Effect.result)
        )
      ).toBe(conflict);
      const envelope = yield* client.seal(recipient.did, "still original");

      const signingDoc = docs
        .find((value) => value.id === sender.did)
        ?.verificationMethod.find(
          (value) => value.id === `${sender.did}#atproto`
        );

      if (signingDoc === undefined) {
        throw new Error("Missing signing key");
      }

      const publicKey = yield* Effect.tryPromise(() =>
        crypto.subtle.importKey(
          "jwk",
          signingDoc.publicKeyJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"]
        )
      ).pipe(Effect.orDie);

      const payload = yield* open({
        envelope,
        recipientDid: recipient.did,
        recipientKey: yield* importAgreement(recipient),
        recipientKeyId: `${recipient.did}#encryption`,
        resolveSigningKey: () => Effect.succeed(publicKey),
      });

      expect(new TextDecoder().decode(payload.body)).toBe("still original");
    }).pipe(Effect.scoped)
);
