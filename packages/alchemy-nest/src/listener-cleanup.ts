import { Effect } from "effect";

import type { Interface } from "./host-shell.ts";
import { stopUnits } from "./startup-contract.ts";

export const stopUnlessServing = Effect.fn("Listeners.stopUnlessServing")(
  function* stop(
    shell: Interface,
    serving: Effect.Effect<boolean>,
    names: readonly string[]
  ) {
    if (yield* serving) {
      return yield* Effect.logWarning("LISTENER_MISMATCH_UNITS_LEFT_SERVING");
    }

    return yield* stopUnits(shell, names).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.logError("LISTENER_CLEANUP_FAILED", error),
        onSuccess: () => Effect.void,
      })
    );
  }
);
