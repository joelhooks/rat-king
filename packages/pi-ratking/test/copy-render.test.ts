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
  "quiet direct mail is full alone and inside a mixed digest",
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

    expect(mail.content).toContain(body);
    expect(mail.content).not.toContain('action: "read"');
    expect(mail.content).not.toContain(COPY_NOTE);

    const copy = {
      canRead: () => true,
      content: "copy content",
      details: inboundDetails(
        { ...base, body: "copy body", id: "another-copy" },
        false
      ),
      id: "another-copy",
      line: "- copy item",
    };

    for (const text of [
      renderDigest("intercom", [mail, copy]),
      renderDigest("intercom", [mail, copy], "wake"),
    ]) {
      expect(text).toContain(body);
      expect(text).not.toContain('action: "read"');
      expect(text.split(COPY_NOTE)).toHaveLength(2);
      expect(text.indexOf(COPY_NOTE)).toBeGreaterThan(
        text.lastIndexOf("copy body")
      );
    }
  }
);

it.prop(
  "cc mail keeps its summary followed by the start of its body, with an exact read call only if clipped",
  [Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: -20 }))],
  ([extra]) => {
    const body = "x".repeat(4000 + extra);
    const text = renderInbound("intercom", { ...base, body, copy: true }, true);
    const unsaved = renderInbound("intercom", { ...base, body, copy: true });
    expect(unsaved).toContain(body);
    expect(unsaved).not.toContain('action: "read"');
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
  "plaintext preview stops at a whole grapheme; encrypted context keeps the tail and offers no journal lookup",
  [Schema.Boolean],
  ([encrypted]) => {
    const prefix = "x".repeat(COPY_BODY_MAX - 1);
    const inbound = { ...base, body: `${prefix}e\u0301tail`, encrypted };
    const details = inboundDetails(inbound, false);

    const text = renderDigest("intercom", [
      {
        canRead: () => true,
        content: "",
        details,
        id: inbound.id,
        line: "- Summary: cc",
      },
    ]);

    expect(text).toContain(
      `Summary: cc\n\n${encrypted ? inbound.body : `${prefix}…`}`
    );
    expect(text.includes("e\u0301tail")).toBe(encrypted);
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
        canRead: () => true,
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

it.prop(
  "a clipped data copy closes the JSON fence before the read hint",
  [Schema.Int.check(Schema.isBetween({ maximum: 80, minimum: 1 }))],
  ([extra]) => {
    const body = JSON.stringify({
      $type: "sh.mschf.agentgraph.outcome",
      checkIn: "x".repeat(COPY_BODY_MAX + extra),
      gate: "pass",
      outcome: "committed",
      version: "0.1",
    });

    const text = renderInbound(
      "intercom",
      { ...base, body, kind: "data" },
      true
    );

    expect(text).toContain("```json\n");
    expect(text).toContain("…\n```\n(clipped; read the full body");
    expect(text).not.toContain(body);
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
