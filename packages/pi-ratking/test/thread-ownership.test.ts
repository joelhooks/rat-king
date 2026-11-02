import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { layer, RatKingMailbox } from "@rat-king/mailbox-client";
import { Directory } from "@rat-king/ratking-client/directory";
import { PayloadJson } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import {
  projectThread,
  ThreadControl,
} from "@rat-king/ratking-client/thread-routing";
import { Threads, threadsLayer } from "@rat-king/ratking-client/threads";
import { Arbitrary, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { runAction } from "../src/tool.ts";
import { fakeMailbox } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

it.live.prop(
  "first owner reply reaches the original sender sealed and claims its root; each thread tool action sends one signed control to the router",
  [
    Arbitrary.schema(Schema.Boolean),
    Arbitrary.schema(Schema.NonEmptyString),
    Arbitrary.schema(Schema.Literals(["forward", "relay", "dispatch"])),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([encrypt, body, source, configured]) =>
    Effect.gen(function* ownershipProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const mailbox = fakeMailbox("accept");
      const sender = yield* identity("did:web:sender.agents.example.invalid");
      const router = yield* identity("did:web:router.agents.example.invalid");
      const originalId = "3m7x2ka4xv22a";
      const root = "3m7x2ka4xv22b";

      yield* Effect.gen(function* proveReplyAndControls() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;
        const threads = yield* Threads;

        yield* directory.record("sender", yield* document(sender));
        yield* directory.record("router", yield* document(router));
        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            reads: false,
            session: "thread-owner",
          },
          () => Effect.void
        );

        const projected = projectThread("tester", {
          did: router.did,
          encrypted: encrypt,
          from: "router",
          id: "forward-envelope",
          record: {
            $type: "sh.mschf.ratking.thread#message",
            original: {
              $type: "sh.mschf.ratking.relay#message",
              body,
              cc: false,
              did: sender.did,
              encrypted: encrypt,
              from: "sender",
              id: originalId,
              kind: "ask",
              label: null,
              replyTo: root,
              summary: null,
              to: "router",
              verified: true,
            },
            reply: { parent: root, root },
            thread: root,
          },
          replyTo: Option.none(),
          verified: true,
        });

        if (Option.isNone(projected)) {
          throw new Error("Expected trusted forward");
        }

        let message: Inbound = projected.value;

        if (source !== "forward") {
          const { threadRouter, ...original } = message;

          if (threadRouter === undefined) {
            throw new Error("Missing router source");
          }

          message =
            source === "relay"
              ? { ...original, relay: threadRouter }
              : { ...original, did: router.did, from: "router" };
        }

        yield* threads.remember(message);
        const reply = yield* ratking.reply(originalId, body);
        const recipient = source === "dispatch" ? router : sender;
        const recipientName = source === "dispatch" ? "router" : "sender";

        expect(reply.to).toBe(recipientName);
        expect(mailbox.requests).toHaveLength(2);

        const documents = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.toType(Defs.DidDocument))
        )(yield* directory.documents);

        const openAs = (index: number, peer: typeof sender) => {
          const envelope = mailbox.requests[index];

          if (envelope === undefined) {
            return Effect.die("Missing envelope");
          }

          expect(envelope.suite.aeadId !== 0).toBe(encrypt);

          return RatKingMailbox.use((client) => client.open(envelope)).pipe(
            Effect.provide(
              layer({
                documents,
                endpoint: "https://mailbox.example.invalid",
                identity: peer,
                serviceDid: "did:web:mailbox.example.invalid",
              })
            )
          );
        };

        const openedReply = yield* openAs(0, recipient);

        const payload = yield* Schema.decodeEffect(PayloadJson)(
          openedReply.body
        );

        expect(payload).toMatchObject({
          body,
          from: "tester",
          kind: "reply",
          reply: { parent: originalId, root },
          thread: root,
          to: recipientName,
        });
        expect(openedReply.replyTo).toEqual({
          messageId: originalId,
          senderDid: recipient.did,
        });
        const openedClaim = yield* openAs(1, router);

        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(ThreadControl))(
            openedClaim.body
          )
        ).toEqual({
          $type: "sh.mschf.ratking.thread#control",
          op: "claim",
          thread: root,
        });

        for (const action of [
          "thread-claim",
          "thread-release",
          "thread-escalate",
          "thread-handback",
        ] as const) {
          const before = mailbox.requests.length;

          const result = yield* runAction("ratking", 600, {
            action,
            encrypt,
            message: body,
            thread: root,
            to: "router",
          });

          expect(result.isError).toBe(false);
          expect(mailbox.requests).toHaveLength(before + 1);
          const opened = yield* openAs(before, router);

          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(ThreadControl))(
              opened.body
            )
          ).toEqual({
            $type: "sh.mschf.ratking.thread#control",
            message: body,
            op: action.slice("thread-".length),
            thread: root,
          });
        }
      }).pipe(
        Effect.provide(
          harness(state, mailbox.http, [], {
            encrypt,
            threadRouting:
              source === "forward" && !configured ? [] : [{ name: "router" }],
          }).pipe(Layer.provideMerge(threadsLayer))
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 }, timeout: 30_000 }
);
