import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { attend, isOperator } from "@rat-king/ratking-client/attend";
import {
  PayloadJson,
  RecordJson,
  renderInbound,
} from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { relayRecord } from "@rat-king/ratking-client/relay";
import type { ThreadDelivery } from "@rat-king/ratking-client/thread-routing";
import { Arbitrary, Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { didOf, receiverFixture } from "./thread-fixture.ts";

const root = "3m7x2ka4xv22a";

const originalId = "3m7x2ka4xv22b";

const original = (from = "sender", body = "follow-up"): Inbound => ({
  body,
  cc: false,
  did: didOf(from),
  from,
  id: originalId,
  kind: "message",
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.none(),
  thread: root,
  to: "tester",
  verified: true,
});

const Case = Schema.Struct({
  encrypted: Schema.Boolean,
  mode: Schema.Literals(["name", "to"]),
  reason: Schema.Literals([
    "pass",
    "unowned",
    "failed",
    "direct",
    "operator",
    "disabled",
  ]),
});

it.live.prop(
  "F1: thread routing composes with both legacy relay endpoints and leaves every non-pass-through outcome on the original relay path",
  [Arbitrary.schema(Case)],
  ([sample]) =>
    Effect.gen(function* relayComposition() {
      const from = sample.reason === "operator" ? "operator" : "sender";

      const body =
        sample.reason === "direct" ? "@tester a decision please" : "follow-up";

      const claim = {
        body: JSON.stringify({
          $type: "sh.mschf.ratking.thread#control",
          op: "claim",
          thread: root,
        }),
        encrypted: sample.encrypted,
        from: "alpha",
      };

      const final =
        sample.mode === "to"
          ? {
              body: JSON.stringify(
                relayRecord(original(from, body), sample.encrypted)
              ),
              encrypted: sample.encrypted,
              from: "gateway",
            }
          : {
              body: () =>
                Schema.encodeSync(PayloadJson)({
                  body,
                  from,
                  thread: root,
                  to: "tester",
                }),
              encrypted: sample.encrypted,
              from,
            };

      const result = yield* receiverFixture(
        sample.reason === "unowned" ? [final] : [claim, final],
        {
          relays: [
            {
              fallbackMinutes: 10,
              mode: "front",
              name: sample.mode === "name" ? "tester" : "gateway",
              to: sample.mode === "name" ? "beta" : "tester",
            },
          ],
          threadRouting: [
            {
              name: "tester",
              senders:
                sample.reason === "disabled" ? [] : ["sender", "operator"],
            },
          ],
        },
        sample.reason === "failed" ? "alpha" : ""
      );

      const sent = yield* Effect.forEach(
        result.outgoing,
        (entry) => Schema.decodeEffect(RecordJson)(entry.body),
        { concurrency: 1 }
      );

      const types = sent.map((entry) => entry.$type);

      const passed = sample.reason === "pass";
      const attempted = passed || sample.reason === "failed";

      expect(
        types.filter((type) => type === "sh.mschf.ratking.thread#message")
      ).toHaveLength(attempted ? 1 : 0);
      expect(
        types.filter((type) => type === "sh.mschf.ratking.relay#message")
      ).toHaveLength(!passed && sample.mode === "name" ? 1 : 0);
      expect(
        types.filter((type) => type === "sh.mschf.ratking.relay#handled")
      ).toHaveLength(passed && sample.mode === "to" ? 1 : 0);
      expect(
        result.outgoing.every((entry) => entry.encrypted === sample.encrypted)
      ).toBe(true);

      const messages = result.received.filter((entry) => "body" in entry);

      expect(messages).toHaveLength(passed || sample.mode === "to" ? 1 : 0);

      if (messages[0] !== undefined) {
        expect(messages[0].from).toBe(from);
        expect(messages[0].body).toBe(body);
        expect(messages[0].routedCopy === true).toBe(passed);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 24 }, timeout: 30_000 }
);

const OwnerCase = Schema.Struct({
  encrypted: Schema.Boolean,
  from: Schema.Literals(["sender", "operator", "joel"]),
  intent: Schema.Literals(["normal", "quiet", "cc", "delegated", "noReply"]),
  trusted: Schema.Boolean,
});

it.live.prop(
  "F2 and F5: only opted-in owners trust forwarded originals; other owners receive labelled unverified mail without operator privileges or forced attention",
  [Arbitrary.schema(OwnerCase)],
  ([sample]) =>
    Effect.gen(function* unconfiguredOwner() {
      const delivery: typeof ThreadDelivery.Type = {
        copy: sample.intent === "cc",
        noReply: sample.intent === "noReply",
        quiet: sample.intent === "quiet",
      };

      if (sample.intent === "delegated") {
        Object.assign(delivery, { delegatedTo: "another-owner" });
      }

      const claimed = {
        ...original(),
        did: didOf(sample.from),
        from: sample.from,
      };

      const record = {
        $type: "sh.mschf.ratking.thread#message",
        delivery,
        original: relayRecord(claimed, sample.encrypted),
        router: "gateway",
        thread: root,
      };

      const result = yield* receiverFixture(
        [
          {
            body: JSON.stringify(record),
            encrypted: sample.encrypted,
            from: "gateway",
          },
        ],
        { threadRouting: sample.trusted ? [{ name: "gateway" }] : [] }
      );

      const message = result.received.find((entry) => "body" in entry);

      expect(message).toBeDefined();

      if (message === undefined || !("body" in message)) {
        throw new Error("Forward was swallowed as a data record");
      }

      expect(message.id).toBe(sample.trusted ? originalId : result.finalId);
      expect(message.from).toBe(sample.trusted ? sample.from : "gateway");
      expect(message.verified).toBe(sample.trusted);
      expect(isOperator(message)).toBe(
        sample.trusted && sample.from !== "sender"
      );
      expect(message.threadRouter?.name).toBe(
        sample.trusted ? "gateway" : undefined
      );
      expect(message.routedWake).toBeUndefined();

      if (!sample.trusted) {
        expect(renderInbound("ratking", message)).toContain(
          "Unverified forward from gateway; claimed original sender:"
        );
      } else if (sample.intent !== "noReply") {
        expect(renderInbound("ratking", message)).toContain("via gateway");
      }

      const expected = attend(
        {
          ...claimed,
          ...delivery,
          from: sample.trusted ? sample.from : "gateway",
          verified: sample.trusted,
        },
        { enabled: true },
        0,
        undefined,
        Option.none()
      );

      expect(
        attend(message, { enabled: true }, 0, undefined, Option.none())
      ).toEqual(expected);
      expect(result.outgoing).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 }, timeout: 30_000 }
);
