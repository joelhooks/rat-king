import * as Plan from "alchemy/Plan";
import { Config, Effect } from "effect";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";

export const isDeferredAdoption = (plan: Plan.Plan, fqn: string): boolean => {
  const node = plan.resources[fqn];

  return node?.action === "create" && node.deferredAdoption !== undefined;
};

export const qualifyRecoveryPlan = Effect.fn("Nest.qualifyRecoveryPlan")(
  function* qualifyRecoveryPlan(plan: Plan.Plan) {
    if (
      !(yield* Config.Boolean("RAT_KING_RECOVER_STATE").pipe(
        Config.withDefault(false)
      ))
    ) {
      return yield* Effect.void;
    }

    const rows = Plan.describePlan(plan).resources;

    const plainCreates = rows.filter(
      (row) => row.action === "create" && !isDeferredAdoption(plan, row.fqn)
    );

    const allowed = plainCreates.every(
      (row) =>
        row.resourceType === "Alchemy.Random" &&
        ["store/access-key", "store/secret-key"].includes(row.fqn)
    );

    if (
      !allowed ||
      ![0, 2].includes(plainCreates.length) ||
      rows.some((row) => ["delete", "replace"].includes(row.action))
    ) {
      return yield* refuse(
        "State recovery refuses plain remote creates, deletes or replacements"
      );
    }

    return yield* Effect.void;
  }
);
