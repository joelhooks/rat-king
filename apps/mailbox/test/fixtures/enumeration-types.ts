// @effect-diagnostics missingLayerContext:off -- The Layer mismatch is asserted below by TypeScript itself.
import { Effect, Layer } from "effect";

import type { IssuerStore } from "../../src/issuer-store.ts";
import { NamedCell } from "../../src/issuer.ts";
import { IssuerEnumeration } from "../../src/list-names.ts";

// @ts-expect-error NamedCell is not an IssuerStore capability.
export const illegalEnumeration: Layer.Layer<
  IssuerEnumeration,
  never,
  IssuerStore
> = Layer.effect(
  IssuerEnumeration,
  NamedCell.pipe(Effect.andThen(Effect.die("type fixture")))
);
