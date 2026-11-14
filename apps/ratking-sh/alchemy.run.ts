import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack, Stage, localState } from "alchemy";
import { Config, Effect } from "effect";

import { requireZoneAccount } from "./src/deploy-target.ts";
import RatKingEdge from "./src/worker.ts";

export default Stack(
  "ratking-sh",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* publicEdgeStage() {
    const stage = yield* Stage;

    const expectedAccount = yield* Config.String(
      "RATKING_ZONE_CLOUDFLARE_ACCOUNT_ID"
    );

    const resolve = yield* Cloudflare.CloudflareEnvironment;
    const resolved = yield* resolve;
    yield* requireZoneAccount(stage, expectedAccount, resolved.accountId);
    const edge = yield* RatKingEdge;

    return { stage, url: edge.url };
  }).pipe(Effect.orDie)
);
