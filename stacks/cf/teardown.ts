/* oxlint-disable typescript/promise-function-async -- Fetch and Response promises are wrapped at the Effect HTTP adapter boundary. */
import { Effect, Option, Result, Schema } from "effect";

const Namespaces = Schema.Struct({
  result: Schema.Array(Schema.Struct({ script: Schema.String })).check(
    Schema.isMaxLength(100)
  ),
  result_info: Schema.Struct({
    total_pages: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  }),
  success: Schema.Literal(true),
});

const Missing = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ code: Schema.Int })),
  success: Schema.Literal(false),
});

const json = (response: Response) =>
  Effect.tryPromise({
    catch: () => `status=${response.status} schema=json`,
    try: () => response.json(),
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
        catch: () => "step=http-transport",
        try: () => http(url, { headers, method: "GET" }),
      });
    });

    const httpReason = Effect.fn("Preview.probeHttpReason")(
      function* httpReason(response: Response) {
        const errors = yield* json(response).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Missing)),
          Effect.option
        );

        return Option.isSome(errors)
          ? `status=${response.status} codes=${errors.value.errors.map((error) => error.code).join(",")}`
          : `status=${response.status} schema=cloudflare-errors`;
      }
    );

    const script = yield* Effect.gen(function* scriptAbsence() {
      const response = yield* request(
        `${base}/scripts/${encodeURIComponent(worker)}/settings`
      );

      const missing = yield* json(response).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(Missing)(body).pipe(
            Effect.mapError(
              () => `status=${response.status} schema=script-missing`
            )
          )
        )
      );

      if (
        response.status !== 404 ||
        !missing.errors.some((error) => error.code === 10_007)
      ) {
        return yield* Effect.fail(
          `status=${response.status} codes=${missing.errors.map((error) => error.code).join(",")}`
        );
      }

      return yield* Effect.void;
    }).pipe(Effect.result);

    if (Result.isFailure(script)) {
      return [
        `WORKER_ABSENT_FAIL ${script.failure}`,
        "NAMESPACES_ABSENT_FAIL step=not-checked",
      ];
    }

    const namespaces = yield* Effect.gen(function* namespaceAbsence() {
      for (let page = 1; page <= 1000; page += 1) {
        const response = yield* request(
          `${base}/durable_objects/namespaces?page=${page}&per_page=100`
        );

        if (!response.ok) {
          return yield* Effect.fail(yield* httpReason(response));
        }

        const decoded = yield* json(response).pipe(
          Effect.flatMap((body) =>
            Schema.decodeUnknownEffect(Namespaces)(body).pipe(
              Effect.mapError(
                () => `status=${response.status} schema=namespaces`
              )
            )
          )
        );

        const total = decoded.result_info.total_pages;

        if (total !== undefined && total < page) {
          return yield* Effect.fail(
            `status=${response.status} schema=pagination`
          );
        }

        if (decoded.result.some((namespace) => namespace.script === worker)) {
          return yield* Effect.fail(
            `status=${response.status} step=namespace-present`
          );
        }

        if (decoded.result.length < 100 || page === total) {
          return yield* Effect.void;
        }
      }

      return yield* Effect.fail("schema=pagination-page-cap");
    }).pipe(Effect.result);

    return [
      "WORKER_ABSENT_PASS",
      Result.isFailure(namespaces)
        ? `NAMESPACES_ABSENT_FAIL ${namespaces.failure}`
        : "NAMESPACES_ABSENT_PASS",
    ];
  }
);
