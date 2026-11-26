import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { shadowReport } from "../src/jev-shadow-report.ts";
import type { ScoreRow, ShadowRowValue } from "../src/jev-shadow.ts";

const Case = Schema.Struct({
  acted: Schema.Boolean,
  age: Schema.Int.check(Schema.isBetween({ maximum: 14, minimum: 0 })),
  bin: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
  quiet: Schema.Boolean,
});

const day = 86_400_000;

const asOf = day * 14;

it.prop(
  "metrics agree with pairwise AUC (including ties) and partition on the exact seven-day boundary",
  [Schema.Array(Case)],
  ([input]) => {
    const items = input.map((value, index) => ({
      ...value,
      id: `mail-${index}`,
    }));

    const rows = items.flatMap((item): ShadowRowValue[] => {
      const time = asOf - item.age * day;

      const score: ScoreRow = {
        id: item.id,
        inputTokens: 290,
        latencyMs: 42,
        model: "jev-latest",
        outputTokens: 3,
        probability: item.bin / 4,
        rule: item.quiet ? "Never" : "Now",
        skipped: null,
        time,
        type: "score",
        verdict: item.bin <= 1 ? "quiet" : "now",
      };

      return item.acted
        ? [{ id: item.id, outcome: "acted", time, type: "outcome" }, score]
        : [score];
    });

    const report = shadowReport(rows, asOf);

    const cases = [
      { metrics: report.all, subset: items },
      {
        metrics: report.heldOut,
        subset: items.filter((item) => item.age <= 7),
      },
      { metrics: report.prior, subset: items.filter((item) => item.age > 7) },
    ];

    for (const { metrics, subset } of cases) {
      const positive = subset.filter((item) => item.acted);
      const negative = subset.filter((item) => !item.acted);
      const pairs = positive.flatMap((p) => negative.map((n) => p.bin - n.bin));
      const wins = pairs.filter((pair) => pair > 0).length;
      const ties = pairs.filter((pair) => pair === 0).length;

      const agreed = subset.filter(
        (item) => item.quiet === item.bin <= 1
      ).length;

      const silenced = positive.flatMap((item) =>
        item.bin <= 1 ? [item.id] : []
      );

      expect(metrics.count).toBe(subset.length);
      expect(metrics.aucActed).toBe(
        pairs.length === 0 ? null : (wins + ties / 2) / pairs.length
      );
      expect(metrics.agreement).toEqual({
        agreed,
        comparable: subset.length,
        fraction: subset.length === 0 ? null : agreed / subset.length,
      });
      expect(metrics.wronglySilenced).toEqual(silenced);
      expect(metrics.confusion.byOutcome.acted.quiet).toBe(silenced.length);
      expect(metrics.confusion.byOutcome.acted.now).toBe(
        positive.length - silenced.length
      );
    }
  }
);
