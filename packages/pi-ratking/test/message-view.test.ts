import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { messageView } from "../src/message-view.ts";

const Case = Schema.Struct({
  body: Schema.String.check(
    Schema.isPattern(/^[a-z](?:[a-z ]{0,598}[a-z])?$/u)
  ),
  cc: Schema.Boolean,
  ccNames: Schema.UndefinedOr(
    Schema.Array(Schema.Literal("a")).check(Schema.isMaxLength(1))
  ),
  label: Schema.UndefinedOr(Schema.Literal("📞 Ernestine · Switchboard")),
  padding: Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 0 })),
  replyTo: Schema.UndefinedOr(Schema.Literal("3m7x2ka4xv22b")),
  summary: Schema.UndefinedOr(
    Schema.String.check(Schema.isPattern(/^[A-Z](?:[a-z ]{0,277}[a-z])?$/u))
  ),
  verified: Schema.Boolean,
  width: Schema.Literals([40, 60, 80, 120]),
});

it.effect.prop(
  "collapsed messages fit a phone: at most four lines inside the width, sender first, the summary when there is one, a hidden-line count when clipped, and expansion shows everything",
  [Arbitrary.schema(Case)],
  ([sample]) =>
    Effect.sync(() => {
      const details = {
        ...sample,
        body: `${sample.body}${" lorem".repeat(sample.padding)}\nsecond line complete`,
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

      expect(collapsed.length).toBeGreaterThanOrEqual(2);
      expect(collapsed.length).toBeLessThanOrEqual(4);

      for (const line of collapsed) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(sample.width);
      }

      expect(collapsed[0]).toContain((sample.label ?? "peer").slice(0, 8));

      const shown = collapsed
        .slice(1)
        .map((line) => stripTerminalSequences(line))
        .join(" ");

      const source = sample.summary ?? details.body;

      const fits =
        collapsed.length < 4 || /\+\d+ lines?$/u.test(collapsed.at(-1) ?? "");

      expect(fits || collapsed.length === 4).toBe(true);

      expect(
        shown.replaceAll(/ … \+\d+ lines?$/gu, "").replaceAll(/\s+/gu, "")
      ).toSatisfy((text: string) =>
        source.replaceAll(/\s+/gu, "").startsWith(text.replace(/…$/u, ""))
      );

      if (/\+\d+ lines?$/u.test(collapsed.at(-1) ?? "")) {
        expect(collapsed).toHaveLength(4);
      }

      if ((sample.ccNames?.length ?? 0) > 0) {
        expect(collapsed[0]).toContain("cc: a");
      }

      if (!sample.verified) {
        expect(collapsed[0]).toContain("unverified");
      }

      const expanded =
        messageView({ ...input, expanded: true })
          ?.render(240)
          .map((line) => stripTerminalSequences(line).trimEnd())
          .join("\n") ?? "";

      expect(expanded.replaceAll(/\s+/gu, "")).toContain(
        details.body.replaceAll(/\s+/gu, "")
      );

      if (sample.summary !== undefined) {
        expect(expanded.replaceAll(/\s+/gu, "")).toContain(
          `Summary:${sample.summary}`.replaceAll(/\s+/gu, "")
        );
      }
    })
);
