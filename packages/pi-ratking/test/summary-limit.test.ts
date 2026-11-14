import { it } from "@effect/vitest";
import { SUMMARY_MAX } from "@rat-king/ratking-client/payload";
import { RatKing } from "@rat-king/ratking-client/ratking";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { runAction } from "../src/tool.ts";

const Action = Schema.Literals(["send", "ask", "reply", "record"]);

it.effect.prop(
  "an oversized summary is trimmed and sent, and a summary at the limit goes out whole",
  [Action, Schema.Int.check(Schema.isBetween({ maximum: 400, minimum: 1 }))],
  ([action, length]) =>
    Effect.gen(function* summaryLimit() {
      const sent: unknown[] = [];
      const unavailable = Effect.die("Unexpected service call");

      const delivered = {
        did: "did:web:acme.example.invalid",
        id: "msg-1",
        seq: 1,
        to: "acme/desk",
      };

      const service = RatKing.of({
        ask: (to, body, _timeout, options) =>
          Effect.sync(() => {
            sent.push({ body, options, to });

            return {
              delivered,
              reply: {
                body: "ok",
                did: delivered.did,
                from: "acme/desk",
                id: "msg-2",
              },
            };
          }),
        attention: () => Effect.die("Unexpected attention call"),
        handled: () => unavailable,
        list: unavailable,
        pending: Effect.succeed([]),
        reply: (id, body, options) =>
          Effect.sync(() => {
            sent.push({ body, id, options });

            return delivered;
          }),
        retire: () => unavailable,
        roles: unavailable,
        run: () => unavailable,
        send: (to, body, options) =>
          Effect.sync(() => {
            sent.push({ body, options, to });

            return delivered;
          }),
        status: unavailable,
      });

      const summary = "s".repeat(length);

      const result = yield* runAction("intercom", 1000, {
        action,
        message: "detail",
        record: { $type: "sh.mschf.agentgraph.checkin" },
        replyTo: "msg-0",
        summary,
        to: "acme/desk",
        type: "sh.mschf.agentgraph.checkin",
      }).pipe(Effect.provideService(RatKing, service));

      if (action === "record") {
        expect(sent).toEqual([]);
      } else if (length > SUMMARY_MAX) {
        expect(result.isError).toBe(false);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toHaveProperty(
          ["options", "summary"],
          `${"s".repeat(SUMMARY_MAX - 1)}…`
        );
      } else {
        expect(sent).toHaveLength(1);
        expect(sent[0]).toHaveProperty(["options", "summary"], summary);
      }
    })
);
