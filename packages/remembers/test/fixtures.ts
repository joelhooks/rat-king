import type { Fixture } from "../adapters/testing.ts";
import type { DraftValue, SliceValue } from "../src/contract.ts";

export const claim = (suffix: number): DraftValue["claim"] => ({
  concepts: ["orchid-policy"],
  defect: null,
  kind: "decision",
  privacy: "private",
  project: "orchid",
  recheck: "contradiction",
  sentence: `Orchid requires signed approval number ${suffix}.`,
  type: "policy",
});

export const slice = (conversation: string): SliceValue => ({
  chunks: [
    {
      id: `${conversation}-chunk`,
      role: "user",
      text: '🧪 Invented transcript evidence: the operator approved the violet protocol during a fictional workshop. Special source: "violet unit" "silver unit" "copper unit". Short first line.\nShort second line.\nShort final line.',
    },
  ],
  key: {
    conversation,
    first_chunk: `${conversation}-chunk`,
    last_chunk: `${conversation}-chunk`,
  },
});

export const draft = (conversation: string, suffix: number): DraftValue => ({
  claim: claim(suffix),
  evidence: [
    {
      chunk_id: `${conversation}-chunk`,
      quote: "approved the violet",
    },
  ],
  subject: { orchid: 1 },
});

export const fixture = (suffix: number): Fixture => ({
  at: 1_000_000_000,
  canon: [],
  counts: new Map(),
  drafts: new Map([
    ["one", [draft("one", suffix)]],
    ["two", [draft("two", suffix)]],
  ]),
  projects: ["orchid", "fern"],
  slices: [slice("one"), slice("two")],
});
