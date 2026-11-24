import { layerDurableObjects } from "@alchemy.run/domain/Cloudflare";
import { Layer } from "effect";
import { layerWebCrypto } from "effect/crypto/SecureRandom";

import { Identity } from "./identity.ts";
import { identityViews } from "./views.ts";

export const identityLive = Identity.layer(identityViews).pipe(
  Layer.provide(layerDurableObjects()),
  Layer.provide(layerWebCrypto)
);
