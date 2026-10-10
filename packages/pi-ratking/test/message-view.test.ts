import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { messageView } from "../src/message-view.ts";

const Case = Schema.Struct({
  body: Schema.String.check(Schema.isPattern(/^[a-z]{1,80}$/u)),
  cc: Schema.Boolean,
  label: Schema.UndefinedOr(Schema.Literal("Pocket")),
  replyTo: Schema.UndefinedOr(Schema.Literal("3m7x2ka4xv22b")),
  verified: Schema.Boolean,
  width: Schema.Int.check(Schema.isBetween({ maximum: 160, minimum: 64 })),
});

it.effect.prop(
  "collapsed messages show one fitted sender-and-id line; expansion shows the complete body from details",
  [Arbitrary.schema(Case)],
  ([sample]) =>
    Effect.sync(() => {
      const details = {
        ...sample,
        body: `${sample.body}\nsecond line complete`,
        did: "did:web:peer.example.invalid",
        from: "peer",
        id: "3m7x2ka4xv22a",
        kind: "message",
      };

      const input = {
        details,
        expanded: false,
        theme: { fg: (_color: string, text: string) => text },
        tool: "ratking",
      };

      const collapsed = messageView(input)?.render(sample.width) ?? [];

      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]).toContain(sample.label ?? "peer");
      expect(collapsed[0]).toContain(details.id);
      expect(visibleWidth(collapsed[0] ?? "")).toBeLessThanOrEqual(
        sample.width
      );

      const wide = messageView(input)?.render(240).join("\n") ?? "";

      if (!sample.verified) {
        expect(wide).toContain("unverified");
      }

      if (sample.cc) {
        expect(wide).toContain("CC");
      }

      if (sample.replyTo !== undefined) {
        expect(wide).toContain("↩ in reply to");
      }

      const expanded =
        messageView({ ...input, expanded: true })
          ?.render(240)
          .map((line) => stripTerminalSequences(line).trimEnd())
          .join("\n") ?? "";

      expect(expanded).toContain(details.body);
    })
);
