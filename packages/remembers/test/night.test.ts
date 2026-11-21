import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { TestProbe, testLayer } from "../adapters/testing.ts";
import { codePoints } from "../src/code-points.ts";
import type { DraftValue } from "../src/contract.ts";
import { Delivery, Store } from "../src/contract.ts";
import { runNight } from "../src/night.ts";
import { search } from "../src/recall.ts";
import { observerStep, judgeStep } from "../src/steps.ts";
import { draft, fixture, slice as fixtureSlice } from "./fixtures.ts";

const Seed = Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }));

it.effect.prop(
  "night balances books, merges conversations, resolves astral-prefix cites, and keeps 24-character transcript substrings out of every durable boundary",
  [Seed, Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 }))],
  ([seed, duplicates]) => {
    const base = fixture(seed);

    const data = {
      ...base,
      drafts: new Map(
        base.slices.map((slice) => [
          slice.key.conversation,
          Array.from({ length: duplicates }, () =>
            draft(slice.key.conversation, seed)
          ),
        ])
      ),
    };

    return Effect.gen(function* nightProof() {
      const books = yield* runNight({
        at: data.at,
        epoch: seed,
        owner: "orchid-desk",
        runId: `night-${seed}`,
        visit: duplicates,
      });

      expect(books).toMatchObject({
        cite_failed: 0,
        cites_verified: 2 * duplicates,
        dedupe_merges: 2 * duplicates - 1,
        gated_in: 2 * duplicates,
        observed: 2 * duplicates,
        slices_read: 2,
        stored: 1,
      });
      const store = yield* Store;
      const records = yield* store.search("Orchid", "orchid");
      expect(records).toHaveLength(1);
      expect(records[0]?.stability_days).toBe(2);
      expect(records[0]?.reobserved.map((entry) => entry.conversation)).toEqual(
        ["one", "two"]
      );
      const hits = yield* search({ project: "orchid", text: "Orchid" });
      expect(hits[0]?.quotes[0]).toEqual({
        status: "verified",
        text: "approved the violet",
      });
      const cite = records[0]?.cites[0];
      const text = data.slices[0]?.chunks[0]?.text ?? "";
      expect(cite?.start).toBe(
        codePoints(text.slice(0, text.indexOf("approved"))).length
      );
      const probe = yield* TestProbe;

      const entries = yield* probe.journal();

      for (const entry of entries) {
        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ identity: Delivery }))
        )(entry);

        expect(parsed.identity.epoch).toBe(seed);
        expect(parsed.identity.visit).toBe(duplicates);
      }

      const observe = observerStep(
        fixtureSlice("one").key,
        "fixture-prefix",
        "observed"
      );

      const judge = judgeStep("observed", "fixture-rubric", "judged");
      expect(observe.agent).toEqual({ model: "gpt-6.1-sol", thinking: "low" });
      expect(judge.agent.model).toBe("gpt-6-astra");

      const boundary = JSON.stringify({
        journal: entries,
        notices: yield* probe.notices(),
        plan: { judge, observe },
        records,
        wakes: yield* probe.wakes(),
      });

      for (const slice of data.slices) {
        for (const chunk of slice.chunks) {
          const points = codePoints(chunk.text);

          for (let offset = 0; offset + 24 <= points.length; offset += 1) {
            expect(boundary).not.toContain(
              points.slice(offset, offset + 24).join("")
            );
          }
        }
      }

      expect(yield* store.owed()).toEqual([]);
      expect(yield* store.cursor()).toBe("2");
      expect((yield* probe.notices()).map((notice) => notice.kind)).toEqual([
        "report",
      ]);
    }).pipe(Effect.provide(testLayer(data)));
  }
);

it.effect.prop(
  "privacy fails closed before judge or journaling; failed cites, canon-stated claims, stale claims and raw-copy claims do not persist",
  [
    Seed,
    Schema.Boolean,
    Schema.Literals([
      "Invented transcript evidence: the operator",
      'Special source: "violet unit" "silver unit" "copper unit".',
      "Short first line.\nShort second line.\nShort final line.",
    ]),
  ],
  ([seed, splitSurrogate, rawCopy]) => {
    const base = fixture(seed);
    const candidate = draft("one", seed);

    const privateDrafts = (["secret", "customer", "personal"] as const).map(
      (privacy) => ({ ...candidate, claim: { ...candidate.claim, privacy } })
    );

    const data = {
      ...base,
      canon: ["Orchid canon standing rule."],
      drafts: new Map<string, readonly DraftValue[]>([
        [
          "one",
          [
            ...privateDrafts,
            {
              ...candidate,
              evidence: [
                {
                  chunk_id: "one-chunk",
                  quote: splitSurrogate
                    ? String.fromCodePoint(0xdd_ea)
                    : "never stated here",
                },
              ],
            },
            {
              ...candidate,
              claim: {
                ...candidate.claim,
                sentence: "Orchid canon standing rule.",
              },
            },
            {
              ...candidate,
              claim: {
                ...candidate.claim,
                sentence: rawCopy,
              },
            },
            {
              ...candidate,
              claim: { ...candidate.claim, sentence: "Orchid stale protocol." },
            },
            candidate,
          ],
        ],
      ]),
      slices: base.slices.slice(0, 1),
      verdicts: new Map([
        ["Orchid stale protocol.", { stale: true, truthful: true }],
      ]),
    };

    return Effect.gen(function* gateProof() {
      const books = yield* runNight({
        at: base.at,
        owner: "orchid-desk",
        runId: `gate-${seed}`,
      });

      expect(books).toMatchObject({
        cite_failed: 1,
        gated_in: 1,
        novelty_dropped: 1,
        observed: 8,
        privacy_dropped: 3,
        stored: 1,
        unsafe_dropped: 1,
      });
      const probe = yield* TestProbe;
      const journal = (yield* probe.journal()).join(" ");
      expect(journal).not.toContain("never stated here");
      const store = yield* Store;
      expect(yield* store.search("Orchid", null)).toHaveLength(1);
    }).pipe(Effect.provide(testLayer(data)));
  }
);

it.effect.prop(
  "defect firing uses full-store conversation counts and impact, encrypts payloads and dedupes by defect id",
  [
    Seed,
    Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
    Schema.Literals([1, 2, 3]),
    Schema.Int.check(Schema.isBetween({ maximum: 25, minimum: 7 })),
    Schema.Boolean,
  ],
  ([seed, conversations, impact, signatureLength, astral]) => {
    const base = fixture(seed);

    const defect = {
      component: "orchid",
      id: `defect-${seed}`,
      impact,
      owner: "orchid-desk",
      signature: {
        literal: (astral ? "🧪" : "x").repeat(signatureLength),
        role: null,
      },
    };

    const data = {
      ...base,
      counts: new Map([[defect.id, conversations]]),
      drafts: new Map([
        [
          "one",
          [
            {
              ...draft("one", seed),
              claim: {
                ...draft("one", seed).claim,
                defect,
                type: "defect" as const,
              },
            },
          ],
        ],
      ]),
    };

    return Effect.gen(function* defectProof() {
      const config = {
        at: base.at,
        owner: "orchid-desk",
        runId: `defect-run-${seed}`,
      };

      const books = yield* runNight(config);
      const validSignature = signatureLength >= 8 && signatureLength <= 23;

      const expected =
        validSignature && (conversations >= 3 || impact === 3) ? 1 : 0;

      expect(books.unsafe_dropped).toBe(Number(!validSignature));
      expect(books.stored).toBe(Number(validSignature));
      expect(books.defects_fired).toBe(expected);
      yield* runNight({ ...config, runId: `again-${seed}` });
      const probe = yield* TestProbe;

      const fired = (yield* probe.notices()).filter(
        (notice) => notice.kind === "defect"
      );

      expect(fired).toHaveLength(expected);

      if (fired[0]) {
        expect(fired[0].encrypted).toBe(true);

        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ conversations: Schema.Int }))
        )(fired[0].payload);

        expect(payload.conversations).toBe(conversations);
      }
    }).pipe(Effect.provide(testLayer(data)));
  }
);

it.effect.prop(
  "failed report retains cursor and report debt and sends an alarm",
  [Seed],
  ([seed]) => {
    const data = { ...fixture(seed), failReport: true };

    return Effect.gen(function* reportProof() {
      const exit = yield* Effect.exit(
        runNight({ at: data.at, owner: "orchid-desk", runId: `failed-${seed}` })
      );

      expect(exit._tag).toBe("Failure");
      const store = yield* Store;
      expect(yield* store.cursor()).toBe("");
      expect(yield* store.owed()).toEqual([`failed-${seed}`]);
      const probe = yield* TestProbe;
      expect((yield* probe.notices()).map((notice) => notice.kind)).toContain(
        "alarm"
      );
    }).pipe(Effect.provide(testLayer(data)));
  }
);
