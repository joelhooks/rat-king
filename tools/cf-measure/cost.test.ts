import { expect, it } from "@effect/vitest";
import { Arbitrary, ConfigProvider, Effect, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  cost,
  decodeAnalytics,
  invocationRequests,
  readCost,
  validateWindow,
} from "./cost.ts";

const Count = Schema.Int.check(
  Schema.isBetween({ maximum: 1_000_000_000, minimum: 0 })
);

const window = {
  durationUnit: "gb-seconds",
  from: "2026-01-01T00:00:00Z",
  namespaces: ["a".repeat(32), "b".repeat(32)],
  to: "2026-01-02T00:00:00Z",
  worker: "rat-king-mailbox-preview",
} as const;

const usage = {
  doRequests: 0,
  durationGbSeconds: 0,
  incomingWsMessages: 0,
  rowsRead: 0,
  rowsWritten: 0,
  storageBytes: 0,
  workerRequests: 0,
};

it.prop(
  "20 incoming WebSocket messages equal one DO request, and monthly allowances apply once",
  {
    requests: Arbitrary.schema(Count),
  },
  ({ requests }) => {
    const ws = cost({ ...usage, incomingWsMessages: requests * 20 }, 86_400);
    const http = cost({ ...usage, doRequests: requests }, 86_400);

    expect(ws).toEqual(http);
    expect(ws.parts.doRequests).toBeCloseTo(
      (Math.max(0, requests * 30 - 1_000_000) * 0.15) / 1_000_000 / 30,
      12
    );
  }
);

it.prop(
  "included tiers floor each independent meter at zero before summing",
  {
    scale: Arbitrary.schema(
      Schema.Number.check(
        Schema.isBetween({ maximum: 2, minimum: 0 }),
        Schema.isFinite()
      )
    ),
  },
  ({ scale }) => {
    const result = cost(
      {
        doRequests: scale * 1_000_000,
        durationGbSeconds: scale * 400_000,
        incomingWsMessages: 0,
        rowsRead: scale * 25_000_000_000,
        rowsWritten: scale * 50_000_000,
        storageBytes: scale * 5_000_000_000,
        workerRequests: scale * 10_000_000,
      },
      30 * 86_400
    );

    const excess = Math.max(0, scale - 1);

    expect(result.parts.doRequests).toBeCloseTo((excess * 0.15) / 30, 12);
    expect(result.parts.duration).toBeCloseTo((excess * 5) / 30, 12);
    expect(result.parts.rowsRead).toBeCloseTo((excess * 25) / 30, 12);
    expect(result.parts.rowsWritten).toBeCloseTo((excess * 50) / 30, 12);
    expect(result.parts.storage).toBeCloseTo(excess / 30, 12);
    expect(result.parts.workerRequests).toBeCloseTo((excess * 3) / 30, 12);
    expect(result.listedMetersUsdPerDay).toBeCloseTo(
      Object.values(result.parts).reduce((sum, value) => sum + value, 0),
      12
    );
  }
);

it.effect.prop(
  "WebSocket invocation rows never double-count incoming messages; unknown types fail",
  { messages: Count, requests: Count },
  ({ requests, messages }) =>
    Effect.gen(function* invocationTypes() {
      const total = yield* invocationRequests([
        { dimensions: { type: "fetch" }, sum: { errors: 0, requests } },
        {
          dimensions: { type: "websocket_message" },
          sum: { errors: 0, requests: messages },
        },
      ]);

      const unknown = yield* invocationRequests([
        { dimensions: { type: "new-type" }, sum: { errors: 0, requests: 0 } },
      ]).pipe(Effect.result);

      expect(total).toBe(requests);
      expect(Result.isFailure(unknown)).toBe(true);
    })
);

const account = {
  invocations: [
    { dimensions: { type: "fetch" }, sum: { errors: 0, requests: 4 } },
  ],
  periodic: [
    {
      max: { activeWebsocketConnections: 6, memoryUsageBytes: 1_000_000 },
      sum: {
        activeTime: 10,
        cpuTime: 1,
        duration: 2,
        exceededCpuErrors: 0,
        exceededMemoryErrors: 0,
        fatalInternalErrors: 0,
        inboundWebsocketMsgCount: 20,
        outboundWebsocketMsgCount: 3,
        rowsRead: 7,
        rowsWritten: 8,
      },
    },
  ],
  storage: [{ max: { storedBytes: 9 } }],
  worker: [{ sum: { cpuTimeUs: 1, duration: 2, errors: 0, requests: 10 } }],
};

it.effect(
  "fake GraphQL preserves namespace totals, counts the Worker once and keeps hibernation evidence",
  () =>
    Effect.gen(function* fakeGraphQL() {
      const requests: string[] = [];

      const client = HttpClient.make((request) => {
        requests.push(request.url);

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ data: { viewer: { accounts: [account] } } })
          )
        );
      });

      const result = yield* readCost(window).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CLOUDFLARE_ACCOUNT_ID: "fake-account",
              CLOUDFLARE_ANALYTICS_TOKEN: "fake-analytics-token",
            })
          )
        )
      );

      expect(requests).toHaveLength(2);
      expect(result.usage).toEqual({
        doRequests: 8,
        durationGbSeconds: 4,
        incomingWsMessages: 40,
        rowsRead: 14,
        rowsWritten: 16,
        storageBytes: 18,
        workerRequests: 10,
      });
      expect(
        result.raw[0]?.metrics.periodic[0]?.max.activeWebsocketConnections
      ).toBe(6);
    })
);

it.effect.prop(
  "partial GraphQL data with errors never becomes a zero-cost success",
  [Schema.String],
  ([message]) =>
    Effect.gen(function* partial() {
      const result = yield* decodeAnalytics({
        data: { viewer: { accounts: [account] } },
        errors: [{ message }],
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
    })
);

it.effect("missing SQL metrics and invalid windows fail closed", () =>
  Effect.gen(function* missingMetrics() {
    const result = yield* decodeAnalytics({
      data: {
        viewer: {
          accounts: [
            {
              ...account,
              periodic: [
                { max: account.periodic[0]?.max, sum: { duration: 0 } },
              ],
            },
          ],
        },
      },
    }).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    expect(validateWindow({ ...window, to: window.from })).toBe(false);
    expect(validateWindow({ ...window, namespaces: [] })).toBe(false);
  })
);
