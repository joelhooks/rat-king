import { Effect } from "effect";

import { EnvelopeFailure } from "./failure.ts";

export const cryptoOperation = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () =>
      new EnvelopeFailure({ reason: "Cryptographic operation rejected" }),
    try: operation,
  });
