/* oxlint-disable typescript/promise-function-async -- Fetch and Response promises are wrapped at the Effect HTTP adapter boundary. */
import { Effect, Option, Schema } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";

const Namespaces = Schema.Struct({
  result: Schema.Array(Schema.Struct({ script: Schema.String })),
  result_info: Schema.Struct({ total_pages: Schema.Number }),
  success: Schema.Literal(true),
});

const Missing = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ code: Schema.Number })),
  success: Schema.Literal(false),
});

export const teardownProbe = Effect.fn("Preview.teardownProbe")(
  function* teardownProbe(
    account: string,
    worker: string,
    token: string,
    http: typeof fetch
  ) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers`;
    const headers = { Authorization: `Bearer ${token}` };

    const request = Effect.fn("Preview.probeRequest")(function* request(
      url: string
    ) {
      return yield* Effect.tryPromise({
        catch: () => refuse("Teardown HTTP failed"),
        try: () => http(url, { headers, method: "GET" }),
      });
    });

    const script = yield* request(
      `${base}/scripts/${encodeURIComponent(worker)}/settings`
    );

    const missing = yield* Effect.tryPromise({
      catch: () => refuse("Invalid teardown response"),
      try: () => script.json(),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Missing)), Effect.option);

    if (
      script.status !== 404 ||
      Option.isNone(missing) ||
      !missing.value.errors.some((error) => error.code === 10_007)
    ) {
      return ["WORKER_ABSENT_FAIL", "NAMESPACES_ABSENT_FAIL"];
    }

    for (let page = 1; ; page += 1) {
      const response = yield* request(
        `${base}/durable_objects/namespaces?page=${page}&per_page=100`
      );

      if (!response.ok) {
        return ["WORKER_ABSENT_PASS", "NAMESPACES_ABSENT_FAIL"];
      }

      const namespaces = yield* Effect.tryPromise({
        catch: () => refuse("Invalid teardown response"),
        try: () => response.json(),
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Namespaces)));

      if (namespaces.result.some((namespace) => namespace.script === worker)) {
        return ["WORKER_ABSENT_PASS", "NAMESPACES_ABSENT_FAIL"];
      }

      if (
        !Number.isSafeInteger(namespaces.result_info.total_pages) ||
        namespaces.result_info.total_pages < page ||
        namespaces.result_info.total_pages > 1000
      ) {
        return ["WORKER_ABSENT_PASS", "NAMESPACES_ABSENT_FAIL"];
      }

      if (page === namespaces.result_info.total_pages) {
        return ["WORKER_ABSENT_PASS", "NAMESPACES_ABSENT_PASS"];
      }
    }
  }
);
