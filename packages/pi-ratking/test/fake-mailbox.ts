import * as Defs from "@rat-king/lexicon/defs";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Predicate,
  Schema,
} from "effect";
import { constVoid } from "effect/Function";
import { HttpClient, HttpClientResponse } from "effect/http";

import { WebSocketPort } from "../../mailbox-client/src/watch.ts";

export const quietSocket = Layer.succeed(WebSocketPort, {
  connect: () => {
    const target = new EventTarget();

    return {
      addEventListener: (type, listener, options) => {
        target.addEventListener(type, listener, options);
      },
      close: constVoid,
      readyState: 1,
      removeEventListener: (type, listener) => {
        target.removeEventListener(type, listener);
      },
      send: () => {
        target.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              $type: "sh.mschf.ratking.mailbox.subscribe#notice",
              seq: 0,
            }),
          })
        );
      },
    };
  },
});

export type MailboxMode = "accept" | "flaky" | "hold" | "reject";

export interface FakeMailbox {
  readonly accepted: Deferred.Deferred<boolean>;
  readonly calls: string[];
  readonly http: HttpClient.HttpClient;
  readonly requests: Defs.EncryptedEnvelopeValue[];
  readonly seen: Deferred.Deferred<boolean>;
}

export const fakeMailbox = (mode: MailboxMode): FakeMailbox => {
  const requests: Defs.EncryptedEnvelopeValue[] = [];
  const calls: string[] = [];
  const seen = Deferred.makeUnsafe<boolean>();
  const accepted = Deferred.makeUnsafe<boolean>();

  let generation = 0;

  const http = HttpClient.make((request) =>
    Effect.gen(function* mailbox() {
      const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

      calls.push(nsid);

      if (
        nsid.endsWith(".acquireLease") &&
        Predicate.isTagged(request.body, "Uint8Array")
      ) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ did: Schema.String, harness: Schema.Json })
          )
        )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

        generation += 1;

        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            lease: {
              did: input.did,
              expiresAt: DateTime.formatIso(
                DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300_000)
              ),
              generation,
              harness: input.harness,
              leaseId: "3mxcx45mn7sex",
            },
          })
        );
      }

      if (nsid.endsWith(".list")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ events: [], throughSeq: 0 })
        );
      }

      if (nsid.endsWith(".releaseLease")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ released: true })
        );
      }

      if (
        !nsid.endsWith("sh.mschf.ratking.mailbox.send") ||
        !Predicate.isTagged(request.body, "Uint8Array")
      ) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ envelope: Defs.EncryptedEnvelope })
        )
      )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);

      requests.push(input.envelope);
      Deferred.doneUnsafe(seen, Effect.succeed(true));

      if (mode === "flaky" && requests.length === 1) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "MailboxUnavailable" }, { status: 503 })
        );
      }

      if (mode === "hold") {
        return yield* Effect.never;
      }

      if (mode === "reject") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "Conflict" }, { status: 409 })
        );
      }

      Deferred.doneUnsafe(accepted, Effect.succeed(true));

      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          receipt: {
            message: {
              messageId: input.envelope.aad.messageId,
              senderDid: input.envelope.aad.senderDid,
            },
            recipientDid: input.envelope.aad.recipientDid,
            seq: requests.length,
            state: "accepted",
          },
        })
      );
    })
  );

  return { accepted, calls, http, requests, seen };
};
