import * as Defs from "@rat-king/lexicon/defs";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Schema } from "effect";

export const proofLeasePath = "/rat-king/v0/lease";

export const ProofLease = Schema.Struct({
  generation: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  leaseId: Runtime.lexString({ format: "tid", type: "string" }),
  message: Schema.optionalKey(Defs.MessageRef),
  ttl: Schema.Int.check(Schema.isBetween({ maximum: 60_000, minimum: 1 })),
});
