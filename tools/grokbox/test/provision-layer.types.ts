import type { Effect, Layer } from "effect";

import type { provision, provisioningLayer } from "../provision.ts";

type Unmet = Exclude<
  Effect.Services<ReturnType<typeof provision>>,
  Layer.Success<typeof provisioningLayer>
>;

type Leaked = Layer.Services<typeof provisioningLayer>;

export const closed: [Unmet, Leaked] extends [never, never] ? true : never =
  true;
