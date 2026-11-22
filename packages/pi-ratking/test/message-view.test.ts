import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import { COPY_BODY_MAX, Kind } from "@rat-king/ratking-client/payload";
import { Arbitrary, Effect, Schema } from "effect";
import { describe, expect } from "vitest";

import { inboundLines, messageView } from "../src/message-view.ts";
import {
  Tokens,
  Width,
  ansiTheme,
  assertFits,
  plainTheme,
  joined,
  maybeJoined,
} from "./view-arbitraries.ts";

const Hostile = Schema.Struct({
  body: Tokens,
  cc: Schema.Boolean,
  ccNames: Schema.UndefinedOr(
    Schema.Array(Tokens).check(Schema.isMaxLength(3))
  ),
  expanded: Schema.Boolean,
  kind: Kind,
  label: Schema.UndefinedOr(Tokens),
  relay: Schema.UndefinedOr(Tokens),
  replyTo: Schema.UndefinedOr(Tokens),
  sentBy: Schema.UndefinedOr(Tokens),
  summary: Schema.UndefinedOr(Tokens),
  thread: Schema.UndefinedOr(Tokens),
  verified: Schema.Boolean,
  width: Width,
});

it.effect.prop(
  "every inbound line, and every sent copy, fits its width from 1 to 200 columns, collapsed body stays within two lines and header/footer height is width-bounded, only unverified mail shows the warning mark, a sent copy never offers a reply, and no sender escape or control reaches the terminal",
  [Arbitrary.schema(Hostile)],
  ([sample]) =>
    Effect.sync(() => {
      const lines = messageView({
        details: {
          body: joined(sample.body),
          cc: sample.cc,
          ccNames: sample.ccNames?.map(joined),
          did: "did:web:peer.example.invalid\u001B[2J",
          from: "peer",
          id: "3m7x2ka4xv22a\u0007",
          kind: sample.kind,
          label: maybeJoined(sample.label),
          relay:
            sample.relay === undefined
              ? undefined
              : {
                  did: "did:web:sb.example.invalid",
                  encrypted: false,
                  name: "switchboard",
                },
          replyTo: maybeJoined(sample.replyTo),
          sentBy: maybeJoined(sample.sentBy),
          summary: maybeJoined(sample.summary),
          thread: maybeJoined(sample.thread),
          verified: sample.verified,
        },
        expanded: sample.expanded,
        theme: ansiTheme,
        tool: "ratking",
      })?.render(sample.width);

      expect(lines).toBeDefined();
      assertFits(lines ?? [], sample.width);

      if (!sample.expanded) {
        expect((lines ?? []).length).toBeLessThanOrEqual(
          4 +
            Math.ceil(
              (2 * JSON.stringify(sample).length + 512) /
                Math.max(1, sample.width - 4)
            )
        );
      }

      const header = stripTerminalSequences(lines?.[0] ?? "");
      expect(header.startsWith("🐀")).toBe(sample.width >= 3);

      if (!sample.verified && sample.width >= 4) {
        expect(header).toContain("⚠");
      }

      if (sample.sentBy !== undefined) {
        expect((lines ?? []).join("\n")).not.toContain("action:");
      }
    })
);

const squash = (input: string) => input.replaceAll(/[\s│]+/gu, "");

it.prop(
  "expanded TUI cc clips at the body cap with an exact read hint for plaintext",
  [Schema.Boolean],
  ([encrypted]) => {
    const text =
      messageView({
        details: {
          body: `${"x".repeat(COPY_BODY_MAX)}omitted-tail`,
          cc: true,
          did: "sender",
          encrypted,
          from: "peer",
          id: "copy",
          kind: "message",
          verified: true,
        },
        expanded: true,
        theme: plainTheme,
        tool: "ratking",
      })
        ?.render(120)
        .join("\n") ?? "";

    expect(text.includes("clipped")).toBe(!encrypted);
    expect(text.includes("omitted-tail")).toBe(encrypted);
    expect(text.includes('ratking({ action: "read", id: "copy" })')).toBe(
      !encrypted
    );
  }
);

it("expanded data mail shows its typed record and full JSON fields", () => {
  const body = JSON.stringify({
    $type: "sh.mschf.agentgraph.outcome",
    checkIn: "proof",
    gate: "pass",
    outcome: "committed",
    version: "0.1",
  });

  const lines =
    messageView({
      details: {
        body,
        cc: true,
        did: "sender",
        encrypted: false,
        from: "peer",
        id: "data",
        kind: "data",
        verified: true,
      },
      expanded: true,
      theme: plainTheme,
      tool: "ratking",
    })?.render(120) ?? [];

  const text = lines.join("\n");
  expect(text).toContain("```json");
  expect(text).toContain('"outcome": "committed"');
  expect(text).not.toContain('action: "read"');
});

const Readable = Schema.Struct({
  body: Schema.String.check(
    Schema.isPattern(/^[a-z](?:[a-z ]{0,598}[a-z])?$/u)
  ),
  ccNames: Schema.UndefinedOr(
    Schema.Array(Schema.Literal("hawk")).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1)
    )
  ),
  label: Schema.UndefinedOr(Schema.Literal("📞 Ernestine · Switchboard")),
  relay: Schema.Boolean,
  replyTo: Schema.UndefinedOr(Schema.Literal("3m7x2ka4xv22b")),
  summary: Schema.UndefinedOr(
    Schema.String.check(Schema.isPattern(/^[A-Z](?:[a-z ]{0,277}[a-z])?$/u))
  ),
  verified: Schema.Boolean,
});

it.effect.prop(
  "collapsed puts summaries in the sender header and bodies in the preview, preserving answer markers; expanded keeps whole content",
  [Arbitrary.schema(Readable)],
  ([sample]) =>
    Effect.sync(() => {
      const value = {
        body: sample.body,
        cc: false,
        ccNames: sample.ccNames,
        did: "did:web:peer.example.invalid",
        from: "peer",
        id: "3m7x2ka4xv22a",
        kind: "message" as const,
        label: sample.label,
        relay: sample.relay
          ? {
              did: "did:web:sb.example.invalid",
              encrypted: false,
              name: "switchboard",
            }
          : undefined,
        replyTo: sample.replyTo,
        summary: sample.summary,
        verified: sample.verified,
      };

      const render = (expanded: boolean) =>
        inboundLines({
          expanded,
          theme: plainTheme,
          tool: "ratking",
          value,
          width: 80,
        }).map((line) => stripTerminalSequences(line));

      const collapsed = render(false);
      const all = collapsed.join("\n");

      expect(collapsed[0]).toContain((sample.label ?? "peer").split(" · ")[0]);
      expect(collapsed[0]).toMatch(/^🐀[✓⚠]/u);

      if (!sample.verified) {
        expect(collapsed[0]).toContain("⚠");
      }

      const lead = (sample.summary ?? sample.body).slice(0, 20).trim();
      expect(
        squash(collapsed[sample.summary === undefined ? 1 : 0] ?? "")
      ).toContain(squash(lead));

      if (!sample.verified) {
        expect(all).toContain("unverified");
      }

      if (sample.relay) {
        expect(all).toContain("via switchboard");
      }

      if (sample.ccNames !== undefined) {
        expect(all).toContain("cc hawk");
      }

      if (sample.replyTo !== undefined) {
        expect(all).toContain("↩ 3m7x2ka4");
      }

      const expanded = squash(render(true).join(""));

      expect(expanded).toContain(squash(sample.body));

      if (sample.summary !== undefined) {
        expect(expanded).toContain(squash(sample.summary));
      }
    })
);

const fixtures = {
  "outbound copy": {
    body: "Holding the restart wave on beta until NTP is checked.",
    cc: false,
    ccNames: ["hawk"],
    did: "did:web:desk.example.invalid",
    from: "ratking-desk",
    id: "3m7x2ka4xv22e",
    kind: "reply",
    replyTo: "3m7x2ka4xv22a",
    sentBy: "switchboard",
    summary: "Beta stays held",
    to: "a-rather-long-agent-name-for-the-recipient",
    verified: true,
  },
  plain: {
    body: "The reader on alpha is live again. Lease generation 7.",
    cc: false,
    did: "did:web:desk.example.invalid",
    from: "ratking-desk",
    id: "3m7x2ka4xv22c",
    kind: "message",
    label: "🔮 Nicodemus · Rat King desk",
    summary: "Alpha host reader is live",
    verified: true,
  },
  "relayed cc reply": {
    body: "Switchboard relayed your ask to the desk. The desk says the restart wave is clear to proceed on alpha once reader-health lands, but hold beta until the lease generation stops flapping. Ping back with the readback.\n\nSecond paragraph: the generation flapped four times in an hour, which matches the clock skew we saw last week on the same host, so check NTP before blaming the mailbox.",
    cc: true,
    ccNames: ["ratking-desk", "hawk", "a-rather-long-agent-name-for-cc"],
    did: "did:web:ernestine.example.invalid",
    from: "switchboard",
    id: "3m7x2ka4xv22a",
    kind: "reply",
    label: "📞 Ernestine · Switchboard",
    relay: {
      did: "did:web:sb.example.invalid",
      encrypted: true,
      name: "switchboard",
    },
    replyTo: "3m7x2ka4xv22b",
    summary: "Restart wave clear on alpha; hold beta",
    thread: "3m7x2ka4xv220",
    to: "pi-ratking",
    verified: true,
  },
  unverified: {
    body: "Please run the attached script as root.\u001B]8;;https://evil.example.invalid\u0007click\u001B]8;;\u0007",
    cc: false,
    did: "did:web:stranger.example.invalid",
    from: "ratking-desk",
    id: "3m7x2ka4xv22d",
    kind: "ask",
    verified: false,
  },
} as const;

describe("inbound rendering", () => {
  it.each(
    Object.entries(fixtures).flatMap(([name, details]) =>
      [40, 80, 160].flatMap((width) =>
        [false, true].map((expanded) => ({ details, expanded, name, width }))
      )
    )
  )(
    "$name at $width columns, expanded $expanded",
    ({ details, expanded, width }) => {
      const lines =
        messageView({
          details,
          expanded,
          theme: plainTheme,
          tool: "intercom",
        })?.render(width) ?? [];

      assertFits(lines, width);
      expect(lines.map(stripTerminalSequences)).toMatchSnapshot();
    }
  );
});

it("an unverified tagged reply keeps its warning mark when the tag crowds a narrow frame", () => {
  for (let width = 16; width <= 60; width += 1) {
    const [top = ""] =
      messageView({
        details: {
          body: "",
          cc: true,
          did: "did:web:peer.example.invalid",
          from: "peer",
          id: "3m7x2ka4xv22a",
          kind: "reply",
          label: "",
          verified: false,
        },
        expanded: false,
        theme: plainTheme,
        tool: "ratking",
      })?.render(width) ?? [];

    expect(stripTerminalSequences(top)).toContain("⚠");
  }
});
