import { Effect, Schema } from "effect";

import type { DeployConfidenceCatalog } from "./deploy-capabilities.ts";

export const CONFIDENCE_START = "<!-- deploy-confidence:start -->";

export const CONFIDENCE_END = "<!-- deploy-confidence:end -->";

export class InstructionDrift extends Schema.TaggedError<InstructionDrift>()(
  "InstructionDrift",
  { path: Schema.String, reason: Schema.String }
) {
  override get message(): string {
    return `${this.path}: ${this.reason}`;
  }
}

export const renderDeployConfidence = (
  catalog: DeployConfidenceCatalog
): string => {
  const automation =
    catalog.autoDeployStage === "off" && catalog.autoDeployProd === "off"
      ? "Continuous deployment is off."
      : "Continuous deployment is enabled only for the stages marked on below.";

  const capabilities = {
    autoDeployProd: {
      label: "Automatic production deploy",
      state: catalog.autoDeployProd,
    },
    autoDeployStage: {
      label: "Automatic stage deploy",
      state: catalog.autoDeployStage,
    },
    autoRollbackPostPromotion: {
      label: "Automatic rollback after promotion",
      state: catalog.autoRollbackPostPromotion,
    },
    autoRollbackPrePromotion: {
      label: "Automatic rollback before promotion",
      state: catalog.autoRollbackPrePromotion,
    },
    canaryTenant: {
      label: "Provisioned canary tenant",
      state: catalog.canaryTenant,
    },
    gradualRollout: { label: "Gradual rollout", state: catalog.gradualRollout },
  } satisfies Record<
    Exclude<keyof DeployConfidenceCatalog, "deployRunner">,
    {
      readonly label: string;
      readonly state: DeployConfidenceCatalog["autoDeployStage"];
    }
  >;

  return [
    CONFIDENCE_START,
    "",
    automation,
    "",
    ...Object.values(capabilities).map(
      ({ label, state }) => `- ${label}: ${state}.`
    ),
    `- Deploy runner: ${catalog.deployRunner.kind} (${catalog.deployRunner.state}).`,
    "",
    "Off means unavailable for operational use, even if code or fixture tests exist.",
    CONFIDENCE_END,
  ].join("\n");
};

export const updateDeployConfidence = Effect.fn("updateDeployConfidence")(
  function* updateConfidence(
    document: string,
    catalog: DeployConfidenceCatalog,
    path: string
  ) {
    const start = document.indexOf(CONFIDENCE_START);
    const end = document.indexOf(CONFIDENCE_END);

    if (
      start === -1 ||
      end <= start ||
      start !== document.lastIndexOf(CONFIDENCE_START) ||
      end !== document.lastIndexOf(CONFIDENCE_END)
    ) {
      return yield* new InstructionDrift({
        path,
        reason: "Require exactly one ordered deploy-confidence marker pair.",
      });
    }

    return (
      document.slice(0, start) +
      renderDeployConfidence(catalog) +
      document.slice(end + CONFIDENCE_END.length)
    );
  }
);

export const checkDeployConfidence = Effect.fn("checkDeployConfidence")(
  function* checkConfidence(
    document: string,
    catalog: DeployConfidenceCatalog,
    path: string
  ) {
    const expected = yield* updateDeployConfidence(document, catalog, path);

    if (expected !== document) {
      return yield* new InstructionDrift({
        path,
        reason: "Deploy confidence drifted. Run pnpm generate:ship-confidence.",
      });
    }

    return yield* Effect.void;
  }
);
