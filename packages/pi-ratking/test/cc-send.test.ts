/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { layer, RatKingMailbox } from "@rat-king/mailbox-client";
import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Directory } from "../src/directory.ts";
import { PayloadJson } from "../src/payload.ts";
import { RatKing } from "../src/ratking.ts";
import { harness } from "./harness.ts";

it.live.prop(
  "cc seals identical signed payloads, rooted at the first id, after resolving every recipient",
  [Schema.Boolean, Schema.String],
  ([encrypt, body]) =>
    Effect.gen(function* ccProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const envelopes: Defs.EncryptedEnvelopeValue[] = [];
      let rejectCopy = false;

      const http = HttpClient.make((request) =>
        Effect.gen(function* fakeMailbox() {
          if (
            !request.url.endsWith("sh.mschf.ratking.mailbox.send") ||
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

          envelopes.push(input.envelope);

          if (rejectCopy && input.envelope.aad.recipientDid.includes("bob")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "Conflict" }, { status: 409 })
            );
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              receipt: {
                message: {
                  messageId: input.envelope.aad.messageId,
                  senderDid: input.envelope.aad.senderDid,
                },
                recipientDid: input.envelope.aad.recipientDid,
                seq: envelopes.length,
                state: "accepted",
              },
            })
          );
        })
      );

      const peers = [
        yield* identity("did:web:alice.agents.example.invalid"),
        yield* identity("did:web:bob.agents.example.invalid"),
      ];

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        for (const peer of peers) {
          yield* directory.record(
            peer.did.includes("alice") ? "alice" : "bob",
            yield* document(peer)
          );
        }

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            reads: false,
            session: "cc-test",
          },
          () => Effect.void
        );

        const rejected = yield* ratking
          .send("alice", body, { cc: ["missing"] })
          .pipe(Effect.flip);

        expect(rejected.code).toBe("UnknownName");
        expect(envelopes).toHaveLength(0);

        const delivered = yield* ratking.send("alice", body, {
          cc: ["bob", "tester", "alice", "bob"],
          encrypt,
        });

        expect(envelopes).toHaveLength(2);
        expect(
          new Set(envelopes.map((envelope) => envelope.aad.messageId)).size
        ).toBe(2);
        const texts: string[] = [];

        for (const envelope of envelopes) {
          const peer = peers.find(
            (candidate) => candidate.did === envelope.aad.recipientDid
          );

          if (peer === undefined) {
            throw new Error("Unknown recipient");
          }

          const opened = yield* RatKingMailbox.use((mailbox) =>
            mailbox.open(envelope)
          ).pipe(
            Effect.provide(
              layer({
                documents: yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.toType(Defs.DidDocument))
                )(yield* directory.documents),
                endpoint: "https://mailbox.example.invalid",
                identity: peer,
                serviceDid: "did:web:mailbox.example.invalid",
              })
            )
          );

          expect(opened.encrypted).toBe(encrypt);
          texts.push(opened.body);
          const payload = yield* Schema.decodeEffect(PayloadJson)(opened.body);
          expect(payload).toMatchObject({
            body,
            cc: ["bob"],
            from: "tester",
            thread: delivered.id,
            to: "alice",
          });
        }

        expect(new Set(texts).size).toBe(1);
        rejectCopy = true;

        const partial = yield* ratking
          .send("alice", body, { cc: ["bob"], encrypt })
          .pipe(Effect.flip);

        expect(partial.code).toBe("Partial");
        expect(partial.reason).toContain("Accepted by alice");
        expect(envelopes).toHaveLength(4);

        const original = "3m7x2ka4xv22a";
        const [peer] = peers;

        if (peer === undefined) {
          throw new Error("Missing reply recipient");
        }

        const direct = yield* ratking.send("alice", body, {
          encrypt,
          replyTo: { messageId: original, senderDid: peer.did },
          thread: original,
        });

        const envelope = envelopes.find(
          (entry) => entry.aad.messageId === direct.id
        );

        if (envelope === undefined) {
          throw new Error("Missing reply envelope");
        }

        const opened = yield* RatKingMailbox.use((mailbox) =>
          mailbox.open(envelope)
        ).pipe(
          Effect.provide(
            layer({
              documents: yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.toType(Defs.DidDocument))
              )(yield* directory.documents),
              endpoint: "https://mailbox.example.invalid",
              identity: peer,
              serviceDid: "did:web:mailbox.example.invalid",
            })
          )
        );

        expect(opened.replyTo).toEqual({
          messageId: original,
          senderDid: peer.did,
        });
        expect(
          (yield* Schema.decodeEffect(PayloadJson)(opened.body)).thread
        ).toBe(original);
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 30_000 }
);
