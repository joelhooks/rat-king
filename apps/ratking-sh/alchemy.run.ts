import * as Cloudflare from "@alchemy.run/cloudflare";
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare";
import { Stack, Stage, localState } from "alchemy";
import { Config, Effect, Layer, Option } from "effect";

import { bindIdentityRoutes, CustomDomainHosts } from "./src/deploy-routing.ts";
import { requireZoneAccount, TargetFailure } from "./src/deploy-target.ts";
import { issuerConfig } from "./src/identity/admin.ts";
import { identityZone } from "./src/identity/names.ts";
import RatKingEdge from "./src/worker.ts";

export default Stack(
  "ratking-sh",
  {
    providers: Layer.merge(Cloudflare.providers(), domainProviders()),
    state: localState(),
  },
  Effect.gen(function* publicEdgeStage() {
    const stage = yield* Stage;

    const expectedAccount = yield* Config.String(
      "RATKING_ZONE_CLOUDFLARE_ACCOUNT_ID"
    );

    const resolve = yield* Cloudflare.CloudflareEnvironment;
    const resolved = yield* resolve;
    yield* requireZoneAccount(stage, expectedAccount, resolved.accountId);
    const issuer = yield* issuerConfig;

    if (Option.isNone(issuer)) {
      return yield* new TargetFailure({
        reason: "Set RATKING_IDENTITY_ISSUER to the approved public issuer pin",
      });
    }

    const protectedHosts = yield* Config.schema(
      CustomDomainHosts,
      "RATKING_ADDITIONAL_CUSTOM_DOMAINS"
    );

    const zone = Cloudflare.Zone.Zone.lookup({ name: identityZone });
    const edge = yield* RatKingEdge;

    const url = yield* bindIdentityRoutes({
      protectedHosts,
      script: edge.workerName,
      zoneId: zone.zoneId,
    });

    return { stage, url, workerName: edge.workerName };
  }).pipe(Effect.orDie)
);
