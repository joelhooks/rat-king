import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import {
  decodePayload,
  decodeRecord,
  encodePayload,
  inboundReply,
  Kind,
  passMarker,
  renderInbound,
  renderInboundBody,
  replyHint,
} from "../src/payload.ts";
import { alpha, id, integer } from "./client-rule-inputs.ts";

const inbound = (n: number, body: string) => ({
  body,
  cc: false,
  did: `did:web:example.invalid:${n}`,
  from: `sender-${n}`,
  id: `msg-${n}`,
  kind: "message" as const,
  label: Option.none(),
  replyTo: Option.none(),
  summary: Option.none(),
  verified: true,
});

const wire = { body: "hello", from: "sender" };

const parse = (value: Schema.Json) => decodePayload(JSON.stringify(value));

const fromWireJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

it.effect.prop(
  "encoded payloads round-trip body, kind and scoped routing metadata",
  [Schema.String, Kind, id],
  ([body, kind, n]) =>
    Effect.gen(function* roundTrip() {
      const value = {
        body,
        cc: [`project/cc-${n}`],
        from: `sender-${n}`,
        kind,
        thread: `thread-${n}`,
        to: `project/desk-${n}`,
      };

      const json = yield* encodePayload(value);
      expect(yield* decodePayload(json)).toEqual(Option.some(value));
    })
);

it.effect.prop(
  "a record decoder preserves unrecognized nested JSON fields",
  [Schema.Json, alpha(12)],
  ([value, stem]) =>
    Effect.gen(function* forwardCompatible() {
      const object = {
        $type: `sh.example.${stem}.record`,
        future: { values: [value] },
      };

      const json = JSON.stringify(object);

      expect(yield* decodeRecord(json)).toEqual(
        Option.some(fromWireJson(json))
      );
    })
);

it.effect.prop(
  "a JSON object without a string type is not a record",
  [id, Schema.Boolean],
  ([n, missing]) =>
    Effect.gen(function* missingType() {
      const input = missing ? { count: n } : { $type: n };
      expect(yield* decodeRecord(JSON.stringify(input))).toEqual(Option.none());
    })
);

it.effect.prop(
  "trailing non-JSON text never changes a valid record into partial success",
  [id, alpha(10)],
  ([n, word]) =>
    Effect.gen(function* strictJson() {
      expect(
        yield* decodeRecord(`{"$type":"sh.example.demo","id":${n}} ${word}`)
      ).toEqual(Option.none());
    })
);

it.effect.prop(
  "a malformed participant name rejects the whole payload, including nested cc lists",
  [alpha(10), Schema.Literals(["from", "to", "cc"])],
  ([name, slot]) =>
    Effect.gen(function* participant() {
      const invalid = `${name}/`;
      expect(
        yield* parse({
          ...wire,
          [slot]: slot === "cc" ? ["valid", invalid] : invalid,
        })
      ).toEqual(Option.none());
    })
);

it.effect.prop(
  "the wire has no explicit false quiet state",
  [Schema.String, id],
  ([body, n]) =>
    Effect.gen(function* quietFlag() {
      const value = { ...wire, body, from: `sender-${n}` };
      expect(yield* parse({ ...value, quiet: false })).toEqual(Option.none());
      expect(yield* parse({ ...value, quiet: true })).toEqual(
        Option.some({ ...value, quiet: true })
      );
    })
);

it.effect.prop(
  "the payload decoder enforces the hard summary cap, not the display cap",
  [alpha(10)],
  ([word]) =>
    Effect.gen(function* summaryBoundary() {
      const summary = word.padEnd(400, "x");
      expect(yield* parse({ ...wire, summary })).toEqual(
        Option.some({ ...wire, summary })
      );
      expect(yield* parse({ ...wire, summary: `${summary}x` })).toEqual(
        Option.none()
      );
    })
);

it.effect.prop(
  "an incomplete modern reply reference is rejected at decode even with a valid legacy parent",
  [id, Schema.Boolean],
  ([n, noRoot]) =>
    Effect.gen(function* replyBoundary() {
      const replyTo = `parent-${n}`;
      const reply = noRoot ? { parent: replyTo } : { root: replyTo };
      expect(yield* parse({ ...wire, reply, replyTo })).toEqual(Option.none());
    })
);

it.prop(
  "the structured reply parent and root take precedence over a different legacy reference",
  [id, id],
  ([a, b]) => {
    const reply = { parent: `structured-${a}`, root: `root-${b}` };
    expect(
      inboundReply({ reply, replyTo: Option.some(`legacy-${a}`) })
    ).toEqual(Option.some(reply));
  }
);

it.prop(
  "a legacy reply keeps its parent as the root instead of creating a new thread",
  [id],
  ([n]) => {
    const parent = `legacy-${n}`;
    expect(inboundReply({ replyTo: Option.some(parent) })).toEqual(
      Option.some({ parent, root: parent })
    );
  }
);

it.prop(
  "overlong ciphertext-visible bodies are not clipped into a reread the reader cannot perform",
  [integer(1, 40), id],
  ([limit, n]) => {
    const body = "x".repeat(limit + 1);
    const message = inbound(n, body);
    expect(
      renderInboundBody("ratking", { ...message, encrypted: true }, limit, true)
    ).toBe(body);
    expect(
      renderInboundBody(
        "ratking",
        { ...message, encrypted: false },
        limit,
        false
      )
    ).toBe(body);
  }
);

it.prop(
  "a clear readable preview never slices through a grapheme cluster",
  [integer(0, 50), Schema.Literals(["🧑‍💻", "é", "🇦🇺"])],
  ([prefix, glyph]) => {
    const text = "x".repeat(prefix);
    const body = `${text}${glyph}tail`;

    const rendered = renderInboundBody(
      "ratking",
      { ...inbound(1, body), encrypted: false },
      prefix + 1,
      true
    );

    expect(rendered.split("\n")[0]).toBe(`${text}…`);
    expect(rendered).toContain('ratking({ action: "read", id: "msg-1" })');
  }
);

it.prop(
  "a body exactly at its preview limit is returned without a reread hint",
  [integer(1, 120), id],
  ([limit, n]) => {
    const body = "x".repeat(limit);
    expect(
      renderInboundBody(
        "ratking",
        { ...inbound(n, body), encrypted: false },
        limit,
        true
      )
    ).toBe(body);
  }
);

it.prop(
  "a relay reply is solo and offers a separate handled confirmation",
  [id, alpha(12)],
  ([n, tool]) => {
    const message = inbound(n, "fixture");

    const hint = replyHint(tool, {
      ...message,
      relay: { did: message.did, encrypted: false, name: "router" },
    });

    expect(hint).toContain(
      `To reply to ${message.from}: ${tool}({ action: "reply", replyTo: "${message.id}", replyAll: false,`
    );
    expect(hint).toContain(
      `${tool}({ action: "handled", replyTo: "${message.id}" })`
    );
  }
);

it.prop(
  "a sent-copy rendering never hints to reply and preserves the original message",
  [id, alpha(12), alpha(12)],
  ([n, body, sender]) => {
    const rendered = renderInbound("ratking", {
      ...inbound(n, body),
      sentBy: sender,
    });

    expect(rendered).toContain(body);
    expect(rendered).toContain(
      `Context only: ${sender} already sent this. Do not reply to it.`
    );
    expect(rendered).not.toContain('action: "reply"');
  }
);

it.prop(
  "the headless pass marker shows only the short run fingerprint",
  [alpha(12), integer(1, 0xff_ff_ff_ff)],
  ([desk, n]) => {
    const short = n.toString(16).padStart(8, "0");
    const run = `${desk}:${short}${"f".repeat(24)}`;

    const marker = passMarker({
      desk,
      deskDid: `did:web:example.invalid:${desk}`,
      run,
    });

    expect(marker).toBe(`↳ via headless Pi ${desk} (${short})`);
    expect(marker).not.toContain(run);
  }
);
