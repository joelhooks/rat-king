import { Effect, Predicate } from "effect";

import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import {
  assessListeners,
  readListeners,
  stackListeners,
} from "./instance-listeners.ts";
import type { InstanceLayout } from "./instance.ts";
import { inLayoutStack, inStack, mismatchReport } from "./listener-report.ts";

export const listenerProbe = Effect.fn("Celld.listenerProbe")(
  function* listeners(
    shell: Interface,
    publicIPv4: string,
    nodeExpected: boolean,
    sidecarExpected?: boolean,
    layout?: InstanceLayout
  ) {
    const evidence = yield* readListeners(shell, layout);

    const assessment = assessListeners(
      evidence.text,
      publicIPv4,
      nodeExpected,
      sidecarExpected === true,
      evidence.unitCgroups,
      layout
    );

    if (Predicate.isTagged(assessment, "Violation")) {
      const inside = layout === undefined ? inStack : inLayoutStack(layout);

      return yield* refuse(
        `Listener contract did not match: ${mismatchReport(
          stackListeners(evidence.text, evidence.unitCgroups, layout),
          inside
        )}`
      );
    }

    if (!Predicate.isTagged(assessment, "Ready")) {
      return yield* refuse("Listener contract did not match");
    }

    return assessment.receipt;
  }
);
