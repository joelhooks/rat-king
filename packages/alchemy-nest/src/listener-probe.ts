import { Effect, Predicate } from "effect";

import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import { inStack, mismatchReport } from "./listener-report.ts";
import { assessListeners, readListeners, stackListeners } from "./listeners.ts";

export const listenerProbe = Effect.fn("Celld.listenerProbe")(
  function* listeners(
    shell: Interface,
    publicIPv4: string,
    nodeExpected: boolean,
    sidecarExpected?: boolean
  ) {
    const evidence = yield* readListeners(shell);

    const assessment = assessListeners(
      evidence.text,
      publicIPv4,
      nodeExpected,
      sidecarExpected === true,
      evidence.unitCgroups
    );

    if (Predicate.isTagged(assessment, "Violation")) {
      return yield* refuse(
        `Listener contract did not match: ${mismatchReport(
          stackListeners(evidence.text, evidence.unitCgroups),
          inStack
        )}`
      );
    }

    if (!Predicate.isTagged(assessment, "Ready")) {
      return yield* refuse("Listener contract did not match");
    }

    return assessment.receipt;
  }
);
