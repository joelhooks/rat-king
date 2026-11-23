import { it } from "@effect/vitest";
import { Entry } from "@rat-king/lexicon/mailbox.listTraffic";
import type { PayloadValue } from "@rat-king/mailbox-client/payload";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { displayTitle } from "../viewer/display-title.ts";
import { emptySnapshot } from "../viewer/feed.ts";
import { content } from "../viewer/page.ts";
import { projectTraffic } from "../viewer/view.ts";
import type { Message } from "../viewer/view.ts";

const base = {
  addressed: new Set<string>(),
  id: "sample-message",
  key: 1,
  recipients: new Set(["orchard/editor"]),
  sender: "orchard/printer",
  senderName: undefined,
  time: "2026-10-06T00:00:00Z",
};

const signed = (fields: Partial<PayloadValue> = {}): Message => ({
  ...base,
  body: "Raw message",
  mode: "signed",
  payload: {
    body: "First line has the subject\nDetails follow",
    from: base.sender,
    ...fields,
  },
});

const KindPrefix = Schema.Literals([
  "action",
  "blocked",
  "done",
  "fyi",
  "progress",
  "question",
]);

it.prop(
  "stacked transport prefixes, standalone IDs, and signatures leave the subject",
  [
    Arbitrary.schema(KindPrefix),
    Arbitrary.schema(Schema.Literals(["SR 🐀", "🐀"])),
  ],
  ([kind, signature]) => {
    const summary = `@orchard-editor-20261006T123456-89abcdef @orchard/printer ${kind} orchard/printer · Packet 123abcd from orchard/printer: Mira: Printed 123abcd the orchard map orchard-printer-20261006T123456-1234abcd for visitors ${signature}`;
    expect(displayTitle(signed({ summary }))).toBe(
      "Printed the orchard map for visitors"
    );
  }
);

it.prop(
  "the first sentence wins if it ends before the character limit",
  [Arbitrary.schema(Schema.Literals([".", "!", "?"]))],
  ([end]) => {
    const summary = `The map is at example.invalid${end} The full print run is ready.`;
    expect(displayTitle(signed({ summary }))).toBe(
      "The map is at example.invalid…"
    );
  }
);

it.prop(
  "long subjects cut between words and mark the cut",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 20 }))
    ),
  ],
  ([count]) => {
    const summary = `Printed ${Array.from({ length: count }, () => "orchard").join(" ")} maps`;
    const title = displayTitle(signed({ summary }));
    expect(title).toBe(`Printed${" orchard".repeat(10)}…`);
  }
);

it.prop(
  "undecorating a short heading does not erase the original",
  [Arbitrary.schema(KindPrefix)],
  ([kind]) => {
    const original = `${kind} orchard/printer · Print failed`;
    expect(displayTitle(signed({ summary: `  ${original}  ` }))).toBe(original);
  }
);

it("uses only the first body line when a summary is absent", () => {
  expect(displayTitle(signed())).toBe("First line has the subject");
});

it("does not strip ordinary words made from hexadecimal letters", () => {
  expect(
    displayTitle(signed({ summary: "Replaced the defaced map 123abcd" }))
  ).toBe("Replaced the defaced map");
});

it.prop(
  "sealed headings use short names but keep full DIDs in the tooltip",
  [Arbitrary.schema(Schema.Boolean)],
  ([delegated]) => {
    const sender = "did:web:printer--orchard.example.invalid";
    const recipient = "did:web:editor.example.invalid";

    const entry = {
      ciphertextSize: 29,
      messageId: "3jzfcijpj2z2a",
      recipientDid: recipient,
      recipientSeq: 1,
      senderDid: sender,
      seq: 1,
      state: "accepted" as const,
      time: base.time,
    };

    const via = {
      desk: "Orchard Press",
      deskDid: sender,
      run: "print:00000000-0000-4000-8000-000000000001",
    };

    const projects = projectTraffic([
      Schema.decodeUnknownSync(Entry.schema)(
        delegated ? { ...entry, via } : entry
      ),
    ]);

    const html = content({ ...emptySnapshot, projects }, new URLSearchParams());
    const from = delegated ? "Orchard Press" : "printer--orchard";

    expect(html).toContain(
      `<strong title="${sender} → ${recipient}">Sealed · ${from} → editor</strong>`
    );
  }
);

it.prop(
  "a thread row keeps sender, kind, and time separate from its shortened title; detail keeps the summary",
  [Arbitrary.schema(KindPrefix)],
  ([kind]) => {
    const summary = `${kind} orchard/printer · <Proof> is ready. Check the ink coverage.`;
    const message = signed({ kind: "message", label: "Mira & Co", summary });

    const html = content(
      {
        ...emptySnapshot,
        projects: [
          {
            name: "orchard",
            threads: [{ asks: [], key: message.key, messages: [message] }],
          },
        ],
      },
      new URLSearchParams({ thread: String(message.key) })
    );

    expect(html).toContain(
      `<strong>&lt;Proof&gt; is ready…</strong><span class="rowtop muted"><span>Mira &amp; Co</span><time datetime="${base.time}" title="${base.time}" data-relative-time>${base.time}</time><span class="chip ">${kind}</span>`
    );
    expect(html).toContain(
      `<strong class="summary">${kind} orchard/printer · &lt;Proof&gt; is ready. Check the ink coverage.</strong>`
    );
  }
);
