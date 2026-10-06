/* oxlint-disable promise/prefer-await-to-callbacks -- Effect boundary transformations are not Promise callbacks. */
import * as Traffic from "@rat-king/lexicon/mailbox.listTraffic";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Effect } from "effect";

import { failure } from "./failure.ts";
import { storageOperation } from "./store.ts";
import { trafficPermission } from "./traffic-store.ts";

export const trafficRequest = Effect.fn("Traffic.request")(
  function* trafficRequest(input: {
    readonly request: Request;
    readonly nsid: string;
    readonly issuer: string;
    readonly operators: readonly string[];
    readonly observers: readonly string[];
    readonly read: (
      params: Traffic.ParamsValue,
      issuer: string
    ) => Effect.Effect<
      { readonly body: string; readonly status: number },
      XrpcFailure
    >;
  }) {
    if (input.nsid === Traffic.Method.nsid) {
      yield* storageOperation(() => {
        trafficPermission(input.issuer, input.operators, input.observers);
      });

      if (input.request.method !== "GET") {
        return yield* Effect.fail(failure("InvalidRequest"));
      }

      const params = yield* Traffic.decodeParams([
        ...new URL(input.request.url).searchParams.entries(),
      ]).pipe(Effect.mapError(() => failure("InvalidRequest")));

      const response = yield* input.read(params, input.issuer);

      return new Response(response.body, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
        status: response.status,
      });
    }

    return yield* Effect.void;
  },
  Effect.catchTag("XrpcFailure", (error) =>
    Effect.succeed(
      Response.json({ error: error.error }, { status: error.status })
    )
  )
);
