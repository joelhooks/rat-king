import { DateTime } from "effect";

import type { Route, ScoreRow, ShadowRowValue } from "./jev-shadow.ts";

const DAY = 86_400_000;

const ruleRoutes = {
  Later: "later",
  Never: "quiet",
  Next: "later",
  Now: "now",
} as const;

type OutcomeRow = Extract<ShadowRowValue, { type: "outcome" }>;

type Joined = ScoreRow & { readonly outcome: OutcomeRow["outcome"] };

type Scored = Extract<ScoreRow, { skipped: null }> & {
  readonly outcome: OutcomeRow["outcome"];
};

const scored = (row: Joined): row is Scored => row.skipped === null;

const auc = (rows: readonly Scored[]): number | null => {
  const sorted = rows.toSorted((a, b) => a.probability - b.probability);
  let negatives = 0;
  let positives = 0;
  let wins = 0;
  let groupNegatives = 0;
  let groupPositives = 0;
  let probability: number | undefined;

  for (const row of sorted) {
    if (row.probability !== probability) {
      wins += groupPositives * (negatives + groupNegatives / 2);
      negatives += groupNegatives;
      positives += groupPositives;
      groupNegatives = 0;
      groupPositives = 0;
      ({ probability } = row);
    }

    if (row.outcome === "acted") {
      groupPositives += 1;
    } else {
      groupNegatives += 1;
    }
  }

  wins += groupPositives * (negatives + groupNegatives / 2);
  const pairs = (positives + groupPositives) * (negatives + groupNegatives);

  return pairs === 0 ? null : wins / pairs;
};

const counts = (): Record<Route, number> => ({ later: 0, now: 0, quiet: 0 });

const metrics = (rows: readonly Joined[]) => {
  const predictions = rows.filter(scored);
  const byRule = { later: counts(), now: counts(), quiet: counts() };
  const byOutcome = { ack: counts(), acted: counts(), none: counts() };
  const skipped: Record<string, number> = {};
  const wronglySilenced: string[] = [];
  let agreed = 0;
  let comparable = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let missingUsage = 0;

  for (const row of rows) {
    if (row.skipped !== null) {
      skipped[row.skipped] = (skipped[row.skipped] ?? 0) + 1;
      continue;
    }

    if (row.rule !== null) {
      const rule = ruleRoutes[row.rule];
      byRule[rule][row.verdict] += 1;
      comparable += 1;
      agreed += Number(rule === row.verdict);
    }

    byOutcome[row.outcome][row.verdict] += 1;

    if (row.outcome === "acted" && row.verdict === "quiet") {
      wronglySilenced.push(row.id);
    }

    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    missingUsage += Number(
      row.inputTokens === null || row.outputTokens === null
    );
  }

  return {
    agreement: {
      agreed,
      comparable,
      fraction: comparable === 0 ? null : agreed / comparable,
    },
    aucActed: auc(predictions),
    confusion: { byOutcome, byRule },
    count: rows.length,
    scored: predictions.length,
    skipped,
    usage: { inputTokens, missingUsage, outputTokens },
    wronglySilenced,
  };
};

export const shadowReport = (rows: readonly ShadowRowValue[], asOf: number) => {
  const scores = new Map<string, ScoreRow>();
  const outcomes = new Map<string, OutcomeRow>();

  for (const row of rows) {
    if (row.time > asOf) {
      continue;
    }

    if (row.type === "outcome") {
      const previous = outcomes.get(row.id);

      if (previous === undefined || row.time < previous.time) {
        outcomes.set(row.id, row);
      }
    } else {
      const previous = scores.get(row.id);

      if (previous === undefined || row.time < previous.time) {
        scores.set(row.id, row);
      }
    }
  }

  const cutoff = asOf - 7 * DAY;

  const joined = Array.from(scores.values(), (score) => {
    const outcome = outcomes.get(score.id);

    return {
      ...score,
      outcome:
        outcome !== undefined && outcome.time >= score.time
          ? outcome.outcome
          : ("none" as const),
    };
  });

  return {
    all: metrics(joined),
    asOf: DateTime.formatIso(DateTime.makeUnsafe(asOf)),
    heldOut: metrics(joined.filter((row) => row.time >= cutoff)),
    heldOutFrom: DateTime.formatIso(DateTime.makeUnsafe(cutoff)),
    prior: metrics(joined.filter((row) => row.time < cutoff)),
  };
};
