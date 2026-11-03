import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";

import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import { readWindowReceipts } from "../../../stacks/nest/alarm-windows.ts";

const Inputs = Schema.Struct({
  offset: Schema.Int.check(Schema.isBetween({ maximum: 600, minimum: -600 })),
  receipt: Schema.Boolean,
});

it.effect.prop(
  "a restart is explained only by a window receipt whose span covers it",
  [Inputs],
  ([input]) =>
    Effect.sync(() => {
      const baseline = 1_000_000;
      const start = 2000;
      const end = 2300;

      const entered = (start + input.offset) * 1000;

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: null,
        deploy: null,
        deployKnown: true,
        digest: "ok",
        doctor: true,
        entered: baseline,
        health: 200,
        measurementFailed: false,
        quarantinedHour: 0,
        readers: null,
        receipts: [],
        receiptsKnown: true,
        slots: { free: 100, max: 100 },
        windows: [],
      };

      const first = observeAlarms(emptySources, facts, baseline);

      const second = observeAlarms(
        first.sources,
        {
          ...facts,
          entered,
          windows: input.receipt
            ? [
                {
                  approval: "joel-go-1",
                  celldAfter: { entered: "after", pid: 2 },
                  celldBefore: { entered: "before", pid: 1 },
                  end,
                  kind: "window",
                  reason: "cleanup",
                  result: "success",
                  start,
                },
              ]
            : [],
        },
        entered + 1000
      );

      const covered = input.offset >= 0 && input.offset <= end - start;

      expect(second.readings["celld.restarted"].status).toBe(
        input.receipt && covered ? "ok" : "firing"
      );
    })
);

it.effect(
  "a receipt read through the shell explains a restart, and a bad line hides nothing",
  () =>
    Effect.gen(function* shellRead() {
      const good = {
        approval: "joel-go-1",
        celldAfter: null,
        celldBefore: { entered: "before", pid: 1 },
        end: 2300,
        kind: "window",
        reason: "cleanup",
        result: "success",
        start: 2000,
      };

      const read = vi.fn((path: string) =>
        Effect.succeed(
          path === "/state/window-receipts.jsonl"
            ? new TextEncoder().encode(
                `not json\n${JSON.stringify(good)}\n{}\n`
              )
            : undefined
        )
      );

      yield* TestClock.setTime(2_300_000);
      const windows = yield* readWindowReceipts({ read }, "/state/deploy.json");
      const baseline = 1_000_000;

      const facts: typeof AlarmFacts.Type = {
        cacheBreaches: null,
        deploy: null,
        deployKnown: true,
        digest: "ok",
        doctor: true,
        entered: baseline,
        health: 200,
        measurementFailed: false,
        quarantinedHour: 0,
        readers: null,
        receipts: [],
        receiptsKnown: true,
        slots: { free: 100, max: 100 },
      };

      const first = observeAlarms(emptySources, facts, baseline);

      const during = observeAlarms(
        first.sources,
        { ...facts, entered: 2_100_000, windows },
        2_301_000
      );

      expect(windows).toHaveLength(1);
      expect(during.readings["celld.restarted"].status).toBe("ok");
    })
);
