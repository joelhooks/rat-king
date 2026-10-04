import { Schema } from "effect";

export const CapabilityState = Schema.Literals(["off", "on"]);

export const DeployConfidence = Schema.Struct({
  autoDeployProd: CapabilityState,
  autoDeployStage: CapabilityState,
  autoRollbackPostPromotion: CapabilityState,
  autoRollbackPrePromotion: CapabilityState,
  canaryTenant: CapabilityState,
  deployRunner: Schema.Struct({
    kind: Schema.Literals(["github"]),
    state: CapabilityState,
  }),
  gradualRollout: CapabilityState,
});

export type DeployConfidenceCatalog = typeof DeployConfidence.Type;

export const deployConfidence: DeployConfidenceCatalog = {
  autoDeployProd: "off",
  autoDeployStage: "off",
  autoRollbackPostPromotion: "off",
  autoRollbackPrePromotion: "off",
  canaryTenant: "off",
  deployRunner: { kind: "github", state: "off" },
  gradualRollout: "off",
};
