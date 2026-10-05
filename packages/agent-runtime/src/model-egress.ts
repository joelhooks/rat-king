/* oxlint-disable typescript/promise-function-async -- Injected fetch returns the host transport's Promise. */
import { Effect, Schema } from "effect";

export class EgressRefused extends Schema.TaggedError<EgressRefused>()(
  "EgressRefused",
  {
    reason: Schema.String,
  }
) {}

export const originFetch = (
  baseUrl: string,
  outbound: typeof fetch
): typeof fetch => {
  const { origin } = new URL(baseUrl);

  return (input, init) =>
    Effect.runPromise(
      Effect.gen(function* guardedFetch() {
        const url = yield* Effect.try({
          catch: () =>
            new EgressRefused({ reason: "Invalid model request URL" }),
          try: () => {
            if (input instanceof Request) {
              return new URL(input.url);
            }

            return new URL(input);
          },
        });

        if (
          url.origin !== origin ||
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          return yield* new EgressRefused({
            reason: "Outbound origin refused",
          });
        }

        return yield* Effect.tryPromise({
          catch: () =>
            new EgressRefused({ reason: "Model gateway request failed" }),
          try: () => outbound(input, { ...init, redirect: "error" }),
        });
      })
    );
};
