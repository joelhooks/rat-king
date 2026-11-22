import { it } from "@effect/vitest";
import { addressedElsewhere } from "@rat-king/ratking-client/name";
import {
  COPY_BODY_MAX,
  COPY_NOTE,
  QUIET_BODY_MAX,
  renderInbound,
} from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { Option, Schema } from "effect";
import { describe, expect } from "vitest";

import {
  DIGEST_BODY_MAX,
  inboundDetails,
  renderDigest,
} from "../src/extension.ts";

const base: Inbound = {
  body: "full progress note",
  cc: true,
  ccNames: ["alpha/desk"],
  did: "sender",
  encrypted: false,
  from: "beta/desk",
  id: "3mxaaaaaaaaaa",
  kind: "message",
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.some("Landed the feed slice"),
  to: "gamma/desk",
  verified: true,
};

it.prop(
  "quiet direct mail keeps its body up to the per-item cap without a cc note",
  [Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: -20 }))],
  ([tail]) => {
    const body = "x".repeat(QUIET_BODY_MAX + tail);
    const inbound = { ...base, body, cc: false, quiet: true };

    const mail = {
      content: renderInbound("intercom", inbound),
      details: inboundDetails(inbound, false),
      id: inbound.id,
      line: "- quiet direct mail",
    };

    for (const text of [
      mail.content,
      renderDigest("intercom", [mail]),
      renderDigest("intercom", [mail], "wake"),
    ]) {
      expect(text).toContain(body.slice(0, QUIET_BODY_MAX));
      expect(text.includes('action: "read"')).toBe(tail > 0);
      expect(text).not.toContain("x".repeat(QUIET_BODY_MAX + 1));
      expect(text).not.toContain(COPY_NOTE);
    }
  }
);

it.prop(
  "cc mail keeps its summary followed by the start of its body, with an exact read call only if clipped",
  [Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: -20 }))],
  ([extra]) => {
    const body = "x".repeat(4000 + extra);
    const text = renderInbound("intercom", { ...base, body, copy: true });
    const hint = `intercom({ action: "read", id: "${base.id}" })`;

    expect(text).toContain(
      `Summary: Landed the feed slice\n\n${body.slice(0, 4000)}`
    );
    expect(text).toContain(COPY_NOTE);
    expect(text.includes(hint)).toBe(extra > 0);
    expect(text).not.toContain("x".repeat(4001));
  }
);

it.prop(
  "a digest for a real CC never splits a surrogate pair or advertises a journal lookup for encrypted mail",
  [Schema.Boolean],
  ([encrypted]) => {
    const prefix = "x".repeat(COPY_BODY_MAX - 1);
    const inbound = { ...base, body: `${prefix}🙂tail`, encrypted };
    const details = inboundDetails(inbound, false);

    const text = renderDigest("intercom", [
      { content: "", details, id: inbound.id, line: "- Summary: cc" },
    ]);

    expect(text).toContain(`Summary: cc\n\n${prefix}…`);
    expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(text.includes('action: "read"')).toBe(!encrypted);
  }
);

it.prop(
  "a 30-copy digest preserves every id without inlining more than 16,000 body characters",
  [Schema.Int.check(Schema.isBetween({ maximum: 5000, minimum: 600 }))],
  ([length]) => {
    const mails = Array.from({ length: 30 }, (_, i) => {
      const inbound = {
        ...base,
        body: "x".repeat(length),
        copy: true,
        id: `mail-${i}`,
      };

      return {
        content: "",
        details: inboundDetails(inbound, false),
        id: inbound.id,
      };
    });

    const rendered = renderDigest("ratking", mails);
    const inlined = (rendered.match(/x{10,}/gu) ?? []).join("").length;
    expect(inlined).toBeLessThanOrEqual(DIGEST_BODY_MAX);

    for (const mail of mails) {
      expect(rendered).toContain(`id ${mail.id}\n`);
      expect(rendered).toContain(`action: "read", id: "${mail.id}"`);
    }
  }
);

describe("addressedElsewhere", () => {
  const reserved = {
    "alpha/desk": { aliases: ["alpha"], did: "did:web:alpha" },
  };

  it("is false for mail to this reader, by name or alias", () => {
    expect(addressedElsewhere(reserved, "alpha/desk", "alpha/desk")).toBe(
      false
    );
    expect(addressedElsewhere(reserved, "alpha", "alpha/desk")).toBe(false);
  });

  it("is true when the mail names someone else", () => {
    expect(addressedElsewhere(reserved, "beta/desk", "alpha/desk")).toBe(true);
  });
});
