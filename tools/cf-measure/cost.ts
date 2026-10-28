import { Config, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { MeasureError } from "./model.ts";

export const rates = {
  doRequests: { included: 1_000_000, perMillion: 0.15 },
  durationGbSeconds: { included: 400_000, perMillion: 12.5 },
  rowsRead: { included: 25_000_000_000, perMillion: 0.001 },
  rowsWritten: { included: 50_000_000, perMillion: 1 },
  storageGb: { included: 5, perGbMonth: 0.2 },
  workerRequests: { included: 10_000_000, perMillion: 0.3 },
  wsMessagesPerRequest: 20,
} as const;

export interface Usage {
  readonly doRequests: number;
  readonly incomingWsMessages: number;
  readonly durationGbSeconds: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly storageBytes: number;
  readonly workerRequests: number;
}

export const cost = (usage: Usage, seconds: number) => {
  const days = seconds / 86_400;
  const monthly = (value: number) => (value * 30) / days;

  const charge = (
    value: number,
    rate: { readonly included: number; readonly perMillion: number }
  ) =>
    (Math.max(0, monthly(value) - rate.included) * rate.perMillion) /
    1_000_000 /
    30;

  const billableDoRequests =
    usage.doRequests + usage.incomingWsMessages / rates.wsMessagesPerRequest;

  const parts = {
    doRequests: charge(billableDoRequests, rates.doRequests),
    duration: charge(usage.durationGbSeconds, rates.durationGbSeconds),
    rowsRead: charge(usage.rowsRead, rates.rowsRead),
    rowsWritten: charge(usage.rowsWritten, rates.rowsWritten),
    storage:
      (Math.max(
        0,
        usage.storageBytes / 1_000_000_000 - rates.storageGb.included
      ) *
        rates.storageGb.perGbMonth) /
      30,
    workerRequests: charge(usage.workerRequests, rates.workerRequests),
  };

  return {
    billableDoRequests,
    days,
    listedMetersUsdPerDay: Object.values(parts).reduce(
      (sum, value) => sum + value,
      0
    ),
    parts,
    rates,
  };
};

const Metric = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isFinite()
);

const Periodic = Schema.Struct({
  max: Schema.Struct({
    activeWebsocketConnections: Metric,
    memoryUsageBytes: Metric,
  }),
  sum: Schema.Struct({
    activeTime: Metric,
    cpuTime: Metric,
    duration: Metric,
    exceededCpuErrors: Metric,
    exceededMemoryErrors: Metric,
    fatalInternalErrors: Metric,
    inboundWebsocketMsgCount: Metric,
    outboundWebsocketMsgCount: Metric,
    rowsRead: Metric,
    rowsWritten: Metric,
  }),
});

const Invocation = Schema.Struct({
  dimensions: Schema.Struct({ type: Schema.String }),
  sum: Schema.Struct({ errors: Metric, requests: Metric }),
});

const Account = Schema.Struct({
  invocations: Schema.Array(Invocation),
  periodic: Schema.Array(Periodic),
  storage: Schema.Array(
    Schema.Struct({ max: Schema.Struct({ storedBytes: Metric }) })
  ),
  worker: Schema.Array(
    Schema.Struct({
      sum: Schema.Struct({
        cpuTimeUs: Metric,
        duration: Metric,
        errors: Metric,
        requests: Metric,
      }),
    })
  ),
});

export const requestTypes = ["http", "jsrpc", "alarm"] as const;

export const websocketMessageTypes = ["hibernation"] as const;

export const invocationRequests = Effect.fn("Measure.invocationRequests")(
  function* invocationRequests(rows: readonly (typeof Invocation.Type)[]) {
    let requests = 0;

    for (const row of rows) {
      const { type } = row.dimensions;

      if (requestTypes.some((known) => known === type)) {
        requests += row.sum.requests;
      } else if (!websocketMessageTypes.some((known) => known === type)) {
        const label = /^[a-zA-Z0-9_-]{1,80}$/u.test(type)
          ? type
          : "invalid-type";

        return yield* new MeasureError({
          reason: `Unknown DO invocation type: ${label}; confirm and update the constant sets before estimating`,
        });
      }
    }

    return requests;
  }
);

export const Analytics = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ accounts: Schema.Array(Account) }),
  }),
  errors: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

export interface Window {
  readonly from: string;
  readonly to: string;
  readonly worker: string;
  readonly namespaces: readonly string[];
  readonly durationUnit: "gb-seconds";
}

export const validateWindow = (window: Window) => {
  const seconds = (Date.parse(window.to) - Date.parse(window.from)) / 1000;

  return (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= 86_400 &&
    window.worker === "rat-king-mailbox-preview" &&
    window.namespaces.length > 0 &&
    new Set(window.namespaces).size === window.namespaces.length &&
    window.namespaces.every((id) => /^[a-f0-9]{32}$/u.test(id))
  );
};

export const query = (account: string, window: Window, namespace: string) => {
  const time = `datetime_geq: ${JSON.stringify(window.from)}, datetime_lt: ${JSON.stringify(window.to)}`;
  const ns = `filter: {${time}, namespaceId: ${JSON.stringify(namespace)}}, limit: 10000`;

  return `query { viewer { accounts(filter: {accountTag: ${JSON.stringify(account)}}) {
    worker: workersInvocationsAdaptive(filter: {${time}, scriptName: ${JSON.stringify(window.worker)}}, limit: 10000) { sum { requests errors cpuTimeUs duration } }
    invocations: durableObjectsInvocationsAdaptiveGroups(${ns}) { dimensions { type } sum { requests errors } }
    periodic: durableObjectsPeriodicGroups(${ns}) { sum { duration activeTime cpuTime rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount exceededCpuErrors exceededMemoryErrors fatalInternalErrors } max { activeWebsocketConnections memoryUsageBytes } }
    storage: durableObjectsSqlStorageGroups(${ns}) { max { storedBytes } }
  } } }`;
};

export const decodeAnalytics = Effect.fn("Measure.decodeAnalytics")(
  function* decodeAnalytics(cause: unknown) {
    const result = yield* Schema.decodeUnknownEffect(Analytics)(cause).pipe(
      Effect.mapError(
        () =>
          new MeasureError({
            reason: "Analytics response missing required metrics",
          })
      )
    );

    if (
      (result.errors?.length ?? 0) !== 0 ||
      result.data.viewer.accounts.length !== 1
    ) {
      return yield* new MeasureError({
        reason: "Analytics GraphQL errors or missing account",
      });
    }

    const [account] = result.data.viewer.accounts;

    if (
      account === undefined ||
      [
        account.worker,
        account.invocations,
        account.periodic,
        account.storage,
      ].some((rows) => rows.length >= 10_000)
    ) {
      return yield* new MeasureError({
        reason: "Analytics result truncated or missing account",
      });
    }

    return account;
  }
);

export const readCost = Effect.fn("Measure.readCost")(function* readCost(
  window: Window
) {
  if (!validateWindow(window)) {
    return yield* new MeasureError({
      reason:
        "Require a <=24h window, preview worker and unique namespace IDs; confirm duration units explicitly",
    });
  }

  const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_ANALYTICS_TOKEN");
  const client = yield* HttpClient.HttpClient;

  const results = yield* Effect.forEach(
    window.namespaces,
    (namespace) =>
      Effect.gen(function* readNamespace() {
        const request = yield* HttpClientRequest.post(
          "https://api.cloudflare.com/client/v4/graphql"
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJson({
            query: query(accountId, window, namespace),
          })
        );

        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              () => new MeasureError({ reason: "Analytics transport failed" })
            )
          );

        if (response.status !== 200) {
          return yield* new MeasureError({
            reason: `Analytics HTTP ${response.status}`,
          });
        }

        const json = yield* response.json.pipe(
          Effect.mapError(
            () => new MeasureError({ reason: "Analytics JSON decode failed" })
          )
        );

        const metrics = yield* decodeAnalytics(json);

        return { metrics, namespace };
      }),
    { concurrency: 1 }
  );

  const [first] = results;

  if (first === undefined) {
    return yield* new MeasureError({ reason: "No namespace results" });
  }

  const usage: Usage = {
    doRequests: yield* invocationRequests(
      results.flatMap(({ metrics }) => metrics.invocations)
    ),
    durationGbSeconds: results
      .flatMap(({ metrics }) => metrics.periodic)
      .reduce((total, row) => total + row.sum.duration, 0),
    incomingWsMessages: results
      .flatMap(({ metrics }) => metrics.periodic)
      .reduce((total, row) => total + row.sum.inboundWebsocketMsgCount, 0),
    rowsRead: results
      .flatMap(({ metrics }) => metrics.periodic)
      .reduce((total, row) => total + row.sum.rowsRead, 0),
    rowsWritten: results
      .flatMap(({ metrics }) => metrics.periodic)
      .reduce((total, row) => total + row.sum.rowsWritten, 0),
    storageBytes: results.reduce(
      (total, { metrics }) =>
        total +
        Math.max(0, ...metrics.storage.map((row) => row.max.storedBytes)),
      0
    ),
    workerRequests: first.metrics.worker.reduce(
      (total, row) => total + row.sum.requests,
      0
    ),
  };

  const seconds = (Date.parse(window.to) - Date.parse(window.from)) / 1000;

  return {
    estimate: cost(usage, seconds),
    method:
      "30-day standalone extrapolation; storage uses namespace peak; excludes base plan and Worker CPU; WebSocket message invocations excluded before adding incoming messages at 20:1",
    raw: results,
    units: {
      activeTime: "unconfirmed",
      cpuTime: "unconfirmed",
      duration: window.durationUnit,
    },
    usage,
    window,
  };
});
