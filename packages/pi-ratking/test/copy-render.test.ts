import { it } from "@effect/vitest";
import { addressedElsewhere } from "@rat-king/ratking-client/name";
import {
  COPY_BODY_MAX,
  COPY_NOTE,
  renderInbound,
} from "@rat-king/ratking-client/payload";
import type { Inbound } from "@rat-king/ratking-client/payload";
import { Option, Schema } from "effect";
import { describe, expect } from "vitest";

import { inboundDetails, renderDigest } from "../src/extension.ts";

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
  "quiet direct mail keeps the whole body without a cc note in either digest or alone",
  [Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))],
  ([tail]) => {
    const body = `Body: ${"x".repeat(COPY_BODY_MAX + tail)}`;
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
      expect(text).toContain(body);
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
