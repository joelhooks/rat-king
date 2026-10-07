/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Lazy synthetic HTTP adapter. */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Defs from "../../../packages/lexicon/src/defs.ts";
import * as Send from "../../../packages/lexicon/src/mailbox.send.ts";
import {
  ownIdentity,
  prepare,
} from "../../../packages/mailbox-client/src/prepare.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";

NodeRuntime.runMain(
  Effect.gen(function* syntheticCCVector() {
    const fs = yield* FileSystem.FileSystem;
    const sender = yield* identity("did:web:sender.example.invalid");
    const recipient = yield* identity("did:web:recipient.example.invalid");
    const phone = yield* identity("did:web:phone.example.invalid");
    const peers = yield* Effect.forEach([sender, recipient, phone], document);
    let copy: Defs.EncryptedEnvelopeValue | undefined;

    const http = HttpClient.make((request) =>
      Effect.gen(function* respond() {
        if (!Predicate.isTagged(request.body, "Uint8Array")) {
          throw new Error("Expected JSON body");
        }

        const input = yield* Schema.decodeEffect(
          Schema.fromJsonString(Send.Input)
        )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

        if (input.envelope.aad.recipientDid === phone.did) {
          copy = input.envelope;
        }

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            receipt: {
              message: {
                messageId: input.envelope.aad.messageId,
                senderDid: sender.did,
              },
              recipientDid: input.envelope.aad.recipientDid,
              seq: 1,
              state: "accepted",
            },
          })
        );
      })
    );

    const client = yield* prepare({
      endpoint: "https://mailbox.example.invalid",
      own: yield* ownIdentity(sender),
      peers,
      serviceDid: "did:web:service.example.invalid",
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));

    const primary = yield* client.seal(
      recipient.did,
      "Synthetic CC content from TS client v1"
    );

    const result = yield* client.send(primary, { cc: phone.did });

    if (
      !Predicate.isTagged(result, "Accepted") ||
      result.cc === undefined ||
      !Predicate.isTagged(result.cc, "Accepted") ||
      copy === undefined
    ) {
      throw new Error("v1 client did not seal the copy");
    }

    yield* fs.makeDirectory("apps/ios/build", { recursive: true });
    yield* fs.writeFileString(
      "apps/ios/build/cc-v1.json",
      JSON.stringify({
        envelope: yield* Schema.encodeEffect(Defs.EncryptedEnvelope)(copy),
        phoneAgreement: phone.agreement,
        primary: primary.aad,
        senderSigning: sender.signing,
      })
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
