import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { attend, formatReason } from "@rat-king/ratking-client/attend";
import {
  DeliveryReason,
  DIGEST_REASON,
  deliveryReason,
  Recipients,
  recipientLevels,
  recipientLines,
} from "@rat-king/ratking-client/delivery";
import { Directory } from "@rat-king/ratking-client/directory";
import { Kind, renderInbound } from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import {
  digestDetails,
  inboundDetails,
  renderDigest,
} from "../src/extension.ts";
import { applyDelivery, verdictToHold } from "../src/pending.ts";
import type { Hold } from "../src/pending.ts";
import { runAction } from "../src/tool.ts";
import type { ToolParamsValue } from "../src/tool.ts";
import { harness } from "./harness.ts";

const Word = Schema.String.check(
  Schema.isPattern(/^[a-z]{1,8}(?: [a-z]{1,8}){0,3}$/u)
);

const Row = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,10}$/u));

it.prop(
  "the to recipient always wakes, and a cc wakes only for an ask; the receipt gives one line per recipient",
  [Row, Schema.Array(Row), Kind],
  ([to, cc, kind]) => {
    const levels = recipientLevels(to, cc, kind);
    const lines = recipientLines(levels);

    expect(levels.map((each) => each.name)).toEqual([to, ...cc]);
    expect(levels[0]?.level).toBe("wake");
    expect(
      levels
        .slice(1)
        .every((each) => each.level === (kind === "ask" ? "wake" : "quiet"))
    ).toBe(true);
    expect(lines[0]).toBe(`${to}: woken (to).`);

    for (const [index, name] of cc.entries()) {
      expect(lines[index + 1]).toBe(
        kind === "ask"
          ? `${name}: woken (cc of an ask).`
          : `${name}: quiet copy, no wake (cc: shows next turn or at its digest).`
      );
    }
  }
);

const Arrival = Schema.Struct({
  copy: Schema.optionalKey(Schema.Boolean),
  digestMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 }))
  ),
  kind: Kind,
  relay: Schema.optionalKey(Schema.Literal("relayed")),
  reply: Schema.Boolean,
});

const MODE_REASON = {
  digest: "held: cc digest",
  followUp: "woken: to",
  nextTurn: "quiet: cc",
  steer: "woken",
} as const;

it.prop(
  "the inbound reason agrees with how the reader delivers it, and shows in the header and in details",
  [Arrival],
  ([arrival]) => {
    const { relay, reply, ...rest } = arrival;

    const inbound: Inbound = {
      ...rest,
      body: "progress",
      cc: rest.copy === true,
      did: "did:web:peer.agents.example.invalid",
      from: "peer",
      id: "3mxaaaaaaaaaa",
      label: Option.none(),
      replyTo: reply ? Option.some("3mxbbbbbbbbbb") : Option.none(),
      summary: Option.none(),
      to: "reader",
      verified: true,
    };

    if (relay !== undefined) {
      Object.assign(inbound, {
        relay: {
          did: "did:web:desk.example.invalid",
          encrypted: false,
          name: "desk",
        },
      });
    }

    const tagged = deliveryReason(inbound);
    const reason = formatReason(tagged);

    const hold = applyDelivery<Hold>(
      verdictToHold(attend(inbound, {}, 0, undefined, Option.none())),
      {
        inject: (mode) => mode,
        settle: () => {
          throw new Error("Intent cannot settle");
        },
      }
    );

    expect(Schema.is(DeliveryReason)(tagged)).toBe(true);
    expect(reason.startsWith(MODE_REASON[hold])).toBe(true);

    if (reason.startsWith("woken")) {
      expect(reason).toBe(
        {
          ask: "woken: ask",
          data: "woken: to",
          message: "woken: to",
          reply: "woken: reply",
        }[inbound.kind]
      );
    }

    expect(
      renderInbound("intercom", inbound)
        .split("\n")[0]
        ?.endsWith(` · ${reason}`)
    ).toBe(true);
    expect(inboundDetails(inbound, false).reason).toEqual(tagged);
  }
);

it.prop(
  "a digest names its reason once, at the top, and in its details",
  [Schema.NonEmptyArray(Row)],
  ([ids]) => {
    const mails = ids.map((id) => ({ content: "", details: {}, id }));
    const lines = renderDigest("intercom", mails).split("\n");

    expect(lines[1]).toBe(formatReason(DIGEST_REASON));
    expect(
      lines.filter((line) => line.includes(formatReason(DIGEST_REASON)))
    ).toHaveLength(1);
    expect(digestDetails(mails)).toEqual({ ids, reason: DIGEST_REASON });
  }
);

it.live.prop(
  "a send with a cc returns each recipient's wake level; an @cc refuses before anything is sealed unless ccOnPurpose",
  [Word, Word],
  ([before, after]) =>
    Effect.gen(function* receipt() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const envelopes: Defs.EncryptedEnvelopeValue[] = [];

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

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        for (const name of ["alpha", "bravo"]) {
          yield* directory.record(
            `crew/${name}`,
            yield* document(
              yield* identity(`did:web:${name}.agents.example.invalid`)
            )
          );
        }

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            reads: false,
            session: "cc-wake-test",
          },
          () => Effect.void
        );

        const send = (message: string, ccOnPurpose: boolean) =>
          runAction("intercom", "1 second", {
            action: "send",
            cc: ["crew/bravo"],
            ccOnPurpose,
            message,
            summary: `${before} update`,
            to: "crew/alpha",
          } satisfies ToolParamsValue);

        const delivered = yield* send(`${before} bravo ${after}`, false);

        const sent = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            id: Schema.String,
            recipients: Recipients,
            seq: Schema.Number,
          })
        )(delivered.details);

        expect(delivered.isError).toBe(false);
        expect(envelopes).toHaveLength(2);
        expect(delivered.text.split("\n")).toEqual([
          `Delivered over Rat King (id ${sent.id}, seq ${sent.seq}).`,
          "crew/alpha: woken (to).",
          "crew/bravo: quiet copy, no wake (cc: shows next turn or at its digest).",
        ]);
        expect(sent.recipients).toEqual([
          { level: "wake", name: "crew/alpha" },
          { level: "quiet", name: "crew/bravo" },
        ]);

        const refused = yield* send(`${before} @bravo ${after}`, false);

        expect(refused.isError).toBe(true);
        expect(refused.details.code).toBe("AskAimedAtCc");
        expect(refused.text).toMatch(
          /^AskAimedAtCc: you sent to crew\/alpha with crew\/bravo in cc/u
        );
        expect(envelopes).toHaveLength(2);

        const meant = yield* send(`${before} @bravo ${after}`, true);

        expect(meant.isError).toBe(false);
        expect(envelopes).toHaveLength(4);

        const fyi = yield* send(
          `FYI: the report includes ${before} ${after}`,
          false
        );

        const request = yield* send(`FYI: please review ${before}`, false);

        expect(fyi.isError).toBe(false);
        expect(fyi.text).toContain("Next time use cc for context or quiet");
        expect(request.isError).toBe(false);
        expect(request.text).not.toContain(
          "Next time use cc for context or quiet"
        );
        expect(envelopes).toHaveLength(8);
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 30_000 }
);
