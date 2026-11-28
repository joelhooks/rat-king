import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import {
  classifyShip,
  judgeShip,
  OneWay,
  restartReason,
  shipWindows,
} from "../../../stacks/nest/ship-judge.ts";
import type {
  JudgeHealth,
  WindowFacts,
} from "../../../stacks/nest/ship-judge.ts";
import { epoch, integer, minute, positive } from "./nest-rule-generators.ts";

const sha = "a".repeat(40);

const healthy = {
  listeners: { count: 4, expected: 4 },
  status: "ok",
} satisfies JudgeHealth;

const latency = { p50: null, p95: null };

const traffic = (sent: number, lost = 0): WindowFacts => ({
  ackLatency: latency,
  acked: 0,
  delivered: sent - lost,
  deliveryLatency: latency,
  end: "2026-01-01T00:10:00Z",
  replays: 0,
  sent,
  start: "2026-01-01T00:00:00Z",
  undelivered: lost,
  undeliveredRecipients:
    lost < 2
      ? []
      : [
          { count: lost - 1, did: "did:web:example.invalid" },
          { count: 1, did: "did:web:other.invalid" },
        ],
});

const judge = (
  baseline: WindowFacts,
  after: WindowFacts,
  health: JudgeHealth | null = healthy
) => judgeShip({ after, baseline, health, sha });

const tags = (verdict: ReturnType<typeof judgeShip>) =>
  verdict.reasons.map((reason) => reason._tag);

it.prop(
  "the post-ship window starts one minute after the ship regardless of baseline choice",
  [epoch, integer(1, 120), positive],
  ([ship, minutes, prior]) => {
    const plan = shipWindows(ship, minutes, ship - prior);
    expect(plan.after).toEqual({
      end: ship + (minutes + 1) * minute,
      start: ship + minute,
    });
    expect(plan.baseline.end).toBe(ship - prior);
  }
);

it.prop(
  "moving the input clock translates both equal-length windows, preserving the default baseline endpoint",
  [epoch, integer(1, 120), positive],
  ([ship, minutes, shift]) => {
    const first = shipWindows(ship, minutes);
    const second = shipWindows(ship + shift, minutes);
    expect(first.baseline.end).toBe(ship);
    expect(first.baseline.end - first.baseline.start).toBe(
      first.after.end - first.after.start
    );
    expect(second).toEqual({
      after: { end: first.after.end + shift, start: first.after.start + shift },
      baseline: {
        end: first.baseline.end + shift,
        start: first.baseline.start + shift,
      },
    });
  }
);

it.prop(
  "exactly 20 messages in the quieter window suffice; one fewer does not",
  [integer(20, 2000), Schema.Boolean],
  ([sent, quieterAfter]) => {
    const verdict = (n: number) =>
      quieterAfter
        ? judge(traffic(sent), traffic(n))
        : judge(traffic(n), traffic(sent));

    expect(verdict(20)._tag).toBe("Pass");
    expect(tags(verdict(19))).toContain("InsufficientTraffic");
  }
);

it.prop(
  "exactly two points of delivery loss are tolerated, one further loss is not",
  [integer(2, 300), integer(0, 35)],
  ([block, baselinePercent]) => {
    const sent = block * 100;
    const before = traffic(sent, baselinePercent * block);
    const atLimit = before.undelivered + 2 * block;
    expect(judge(before, traffic(sent, atLimit))._tag).toBe("Pass");
    expect(tags(judge(before, traffic(sent, atLimit + 1)))).toEqual([
      "DeliveryRateDrop",
    ]);
  }
);

it.prop(
  "proportionally scaling traffic does not create a delivery regression from an unchanged rate",
  [integer(3, 50), integer(7, 50), integer(1, 30)],
  ([lost, delivered, volume]) => {
    const baseline = traffic(20 * (lost + delivered), 20 * lost);

    const after = traffic(
      volume * baseline.sent,
      volume * baseline.undelivered
    );

    expect(judge(baseline, after)._tag).toBe("Pass");
  }
);

it.prop(
  "a latency observation cannot fail delivery without both p95 readings",
  [positive, Schema.Boolean],
  ([p95, missingAfter]) => {
    const measured = { ...traffic(100), deliveryLatency: { p50: 0, p95 } };

    const missing = {
      ...traffic(100),
      deliveryLatency: { p50: p95 * 2, p95: null },
    };

    expect(
      (missingAfter ? judge(measured, missing) : judge(missing, measured))._tag
    ).toBe("Pass");
  }
);

const latencyWindow = (p95: number) => ({
  ...traffic(100),
  deliveryLatency: { p50: 0, p95 },
});

it.prop(
  "the latency limit itself is allowed, but one millisecond over is a regression",
  [positive],
  ([p95]) => {
    const allowed = p95 * 2 + 250;
    const before = latencyWindow(p95);
    expect(judge(before, latencyWindow(allowed))._tag).toBe("Pass");
    expect(tags(judge(before, latencyWindow(allowed + 1)))).toEqual([
      "DeliveryLatencyRegression",
    ]);
  }
);

it.prop(
  "a listener overcount alone is never evidence of missing listeners",
  [positive, positive],
  ([expected, surplus]) => {
    expect(
      judge(traffic(100), traffic(100), {
        listeners: { count: expected + surplus, expected },
        status: "ok",
      })._tag
    ).toBe("Pass");
  }
);

it.prop(
  "a held status does not excuse a missing listener",
  [positive, positive],
  ([count, missing]) => {
    const prior = {
      listeners: { count, expected: count },
      reasons: ["old warning"],
      status: "warn",
    } satisfies JudgeHealth;

    const verdict = judgeShip({
      after: traffic(100),
      baseline: traffic(100),
      health: { ...prior, listeners: { count, expected: count + missing } },
      prior,
      sha,
    });

    expect(verdict._tag).toBe("Fail");
    expect(tags(verdict)).toEqual(["ListenersMissing"]);
  }
);

const backupWarning = (n: number): JudgeHealth => ({
  ...healthy,
  reasons: [`backup stop ${n} ms, budget ${n + 1} ms`],
  status: "warn",
});

it.prop(
  "changing only a numeric measurement in a known reason cannot fail the ship",
  [positive, positive],
  ([a, b]) => {
    expect(
      judgeShip({
        after: traffic(100),
        baseline: traffic(100),
        health: backupWarning(a),
        prior: backupWarning(b),
        sha,
      })._tag
    ).toBe("Pass");
  }
);

it.prop(
  "a planned restart covers its own reason without clearing a concurrent new warning",
  [positive],
  ([ms]) => {
    const health = {
      ...healthy,
      reasons: [restartReason, `backup stop ${ms} ms`],
      status: "warn",
    } satisfies JudgeHealth;

    const verdict = judgeShip({
      after: traffic(100),
      baseline: traffic(100),
      health,
      prior: { ...healthy, reasons: [] },
      restarted: true,
      sha,
    });

    expect(tags(verdict)).toEqual(["HealthStatus"]);
  }
);

it.prop(
  "raw-count refusal is a receipt annotation, not a failure, on either side of the comparison",
  [positive, Schema.Boolean],
  ([count, afterRefuses]) => {
    const clean = traffic(100);
    const annotated = { ...clean, readerless: count, readerlessRefused: true };

    const verdict = afterRefuses
      ? judge(clean, annotated)
      : judge(annotated, clean);

    expect(verdict._tag).toBe("Pass");
    expect(tags(verdict)).toEqual(["ReaderlessRefused"]);
    expect(verdict.readerless).toBe(afterRefuses ? count : 0);
  }
);

it.prop(
  "an explicit empty semantic diff takes precedence over a path-only one-way heuristic",
  [positive],
  ([id]) => {
    const paths = [`lexicons/fixture-${id}.json`];
    expect(classifyShip({ oneWayCommits: [], paths })._tag).toBe("OneWay");
    expect(classifyShip({ findings: [], oneWayCommits: [], paths })._tag).toBe(
      "Revertible"
    );
  }
);

it.prop(
  "an explicit one-way trailer remains authoritative even when semantic diff is empty",
  [integer(0, 0xff_ff_ff_ff)],
  ([hex]) => {
    const commit = hex.toString(16).padStart(40, "0");
    expect(
      classifyShip({ findings: [], oneWayCommits: [commit], paths: [] })
    ).toEqual(OneWay.make({ commits: [commit], paths: [] }));
  }
);
