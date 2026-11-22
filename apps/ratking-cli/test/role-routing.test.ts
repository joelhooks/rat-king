import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { ownIdentity, prepare } from "@rat-king/mailbox-client";
import { attend, Reasons, Verdicts } from "@rat-king/ratking-client/attend";
import { Directory } from "@rat-king/ratking-client/directory";
import { secretName } from "@rat-king/ratking-client/name";
import { COPY_NOTE, renderInbound } from "@rat-king/ratking-client/payload";
import { Inbox, RatKing } from "@rat-king/ratking-client/ratking";
import { Arbitrary, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vitest";

import { plaintextBody } from "../../../packages/envelope/src/signed.ts";
import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import {
  inboundDetails,
  renderDigest,
} from "../../../packages/pi-ratking/src/extension.ts";
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
  "direct role mail wakes without a cc note even with a cc list; real copies are labeled quiet and reply-all omits self aliases",
  [
    Arbitrary.schema(Schema.Boolean),
    Schema.Literals(["plain", "listed", "copy", "legacyCc", "envelope"]),
  ],
  ([successor, delivery]) =>
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

      const address = { body: payload.body, from: payload.from };

      const copyRef = {
        messageId: sent.aad.messageId,
        senderDid: sent.aad.senderDid,
      };

      const copyBody = yield* Schema.encodeEffect(PayloadJson)(address);

      const sign = (body: string) =>
        source.seal(TESTER, body, { encrypt: false });

      const wire = yield* Schema.encodeEffect(PayloadJson)(
        delivery === "legacyCc"
          ? { ...address, cc: ["tester"] }
          : {
              ...address,
              cc: ["proj"],
              to: delivery === "copy" ? "peer" : "tester",
            }
      );

      const expiresAt = "2099-01-01T00:00:00.000Z";

      const envelope = yield* Effect.suspend(() => {
        if (delivery === "plain") {
          return Effect.succeed(sent);
        }

        return delivery === "envelope"
          ? source.seal(
              TESTER,
              JSON.stringify({
                $type: "sh.mschf.ratking.mailbox.cc",
                body: copyBody,
                primary: { ...copyRef, recipientDid: who.peer.did },
              }),
              { encrypt: false, expiresAt, replyTo: copyRef }
            )
          : sign(wire);
      });

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

        const rendered = renderInbound("ratking", received);

        const cc =
          delivery === "copy" ||
          delivery === "legacyCc" ||
          delivery === "envelope";

        expect(received.cc).toBe(cc);
        expect(rendered.includes(COPY_NOTE)).toBe(cc);
        expect(received.copy).toBe(cc ? undefined : false);
        expect(received.expiresAt).toBe(
          delivery === "envelope" ? expiresAt : undefined
        );
        expect(attend(received, {}, 0, undefined, Option.none())).toEqual(
          Verdicts.Now({ reason: Reasons.intent({ facts: ["to"] }) })
        );

        if (cc) {
          expect(rendered).toContain("quiet: cc");

          const digest = renderDigest("ratking", [
            {
              content: rendered,
              details: inboundDetails(received, false),
              id: received.id,
            },
          ]);

          expect(digest).toContain(COPY_NOTE);
          expect(digest).toContain(received.body);

          return;
        }

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
  { arbitrary: { runs: 12 }, timeout: 60_000 }
);
