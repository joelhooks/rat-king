import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { attend, Reasons, Verdicts } from "@rat-king/ratking-client/attend";
import { Directory } from "@rat-king/ratking-client/directory";
import { secretName } from "@rat-king/ratking-client/name";
import { Inbox, RatKing } from "@rat-king/ratking-client/ratking";
import { Arbitrary, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import { plaintextBody } from "../../../packages/envelope/src/signed.ts";
import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import {
  ENDPOINT,
  fakeMailbox,
  people,
  seeded,
  SERVICE,
  TESTER,
} from "./fixture.ts";

it.live.prop(
  "forwarded mail addresses and wakes the resolved row; reply-all omits self aliases but explicit self-cc still refuses",
  [Arbitrary.schema(Schema.Boolean), Arbitrary.schema(Schema.Boolean)],
  ([successor, legacyCc]) =>
    Effect.gen(function* roundTrip() {
      const fs = yield* FileSystem.FileSystem;
      const who = yield* people;

      const routes = new Map([
        [
          "proj",
          {
            body: {
              chain: successor
                ? ["proj", "old/desk", "tester"]
                : ["proj", "tester"],
              did: TESTER,
              name: "tester",
            },
            status: 200,
          },
        ],
      ]);

      const outbound = fakeMailbox([], undefined, undefined, { routes });

      const sender = harness(
        yield* fs.makeTempDirectoryScoped(),
        outbound.http,
        [],
        { secrets: new Map([[secretName("peer"), JSON.stringify(who.peer)]]) }
      );

      yield* Effect.gen(function* sendToRole() {
        yield* Directory.use((directory) =>
          directory.record("tester", who.testerDocument)
        );
        yield* Inbox.use((inbox) => inbox.attach("peer"));
        yield* RatKing.use((ratking) =>
          ratking.send("proj", "Invented role message", {
            kind: "message",
            summary: "Invented role message",
          })
        );
      }).pipe(Effect.provide(sender));

      const [sent] = outbound.sends;
      expect(sent).toBeDefined();

      if (sent === undefined) {
        return;
      }

      const payload = yield* Schema.decodeUnknownEffect(PayloadJson)(
        yield* plaintextBody(sent)
      );

      expect(payload.to).toBe("tester");
      expect(payload.cc).toEqual([]);
      expect(
        outbound.calls.find((call) => call.nsid.endsWith(".send"))?.body
      ).toMatchObject({ resolvedFrom: "proj" });

      const source = yield* prepare({
        endpoint: ENDPOINT,
        own: yield* ownIdentity(who.peer),
        peers: [who.testerDocument],
        serviceDid: SERVICE,
      });

      const envelope = legacyCc
        ? yield* source.seal(
            TESTER,
            yield* Schema.encodeEffect(PayloadJson)({
              ...payload,
              cc: ["proj"],
            }),
            { encrypt: false }
          )
        : sent;

      const event = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.MessageEvent)
      )({
        $type: "sh.mschf.ratking.defs#messageEvent",
        envelope,
        receipt: {
          message: {
            messageId: envelope.aad.messageId,
            senderDid: who.peer.did,
          },
          recipientDid: TESTER,
          seq: 1,
          state: "accepted",
        },
        seq: 1,
      });

      const inbound = fakeMailbox(
        [{ event, state: "accepted" }],
        undefined,
        undefined,
        { routes }
      );

      const receiver = harness(
        yield* fs.makeTempDirectoryScoped(),
        inbound.http,
        [],
        { secrets: seeded(who) }
      );

      yield* Effect.gen(function* receiveAndReply() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        const inbox = yield* Inbox;
        yield* inbox.attach("tester");
        const peek = yield* inbox.peek();
        expect(peek.unreadable).toEqual([]);
        const received = peek.messages[0]?.received;
        expect(received).toBeDefined();
        expect(received).not.toHaveProperty("record");

        if (received === undefined || "record" in received) {
          return;
        }

        expect(received.copy).toBe(false);
        expect(attend(received, {}, 0, undefined, Option.none())).toEqual(
          Verdicts.Now({ reason: Reasons.intent({ facts: ["to"] }) })
        );
        const ratking = yield* RatKing;
        yield* ratking.reply(received.id, "Invented reply", { replyAll: true });
        expect(inbound.sends.map((entry) => entry.aad.recipientDid)).toEqual([
          who.peer.did,
        ]);

        const refusal = yield* ratking
          .send("peer", "Invented explicit self cc", { cc: ["proj"] })
          .pipe(Effect.flip);

        expect(refusal.code).toBe("Self");
        expect(inbound.sends).toHaveLength(1);
      }).pipe(Effect.provide(receiver));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
    ),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);
