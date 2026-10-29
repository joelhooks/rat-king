import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  settingsLayer,
  Settings,
} from "../../packages/ratking-client/src/config.ts";
import { directoryLayer } from "../../packages/ratking-client/src/directory.ts";
import { ensureIdentity } from "../../packages/ratking-client/src/identity.ts";
import { issuerLayer } from "../../packages/ratking-client/src/issuer.ts";
import {
  AgentName,
  secretName,
} from "../../packages/ratking-client/src/name.ts";
import {
  SecretStore,
  secretStoreLayer,
} from "../../packages/ratking-client/src/secrets.ts";

export const provision = Effect.fn("Grokbox.provision")(function* provision(
  name: string,
  requestedPrefix?: string
) {
  // oxlint-disable-next-line unicorn/prefer-default-parameters -- Preserve an explicitly typed optional parameter through Effect.fn's generator inference.
  const prefix = requestedPrefix ?? "grokbot/";

  if (
    !prefix.endsWith("/") ||
    !Schema.is(AgentName)(prefix.slice(0, -1)) ||
    !Schema.is(AgentName)(name) ||
    !name.startsWith(prefix) ||
    name.length === prefix.length
  ) {
    return yield* Effect.fail("Name must be under the configured prefix.");
  }

  const settings = yield* Settings;

  if (
    Option.isNone(settings.issuer) ||
    !("endpoint" in settings.issuer.value)
  ) {
    return yield* Effect.fail(
      "Provisioning requires a configured service issuer."
    );
  }

  if (Object.hasOwn(settings.reserved, name)) {
    return yield* Effect.fail("Bot names must not be reserved.");
  }

  const store = yield* SecretStore;

  if (yield* store.exists(secretName(name))) {
    return yield* Effect.fail(
      "Identity key already exists; not provisioning again."
    );
  }

  const identity = yield* ensureIdentity(name);

  return { did: identity.did, name };
});

export const provisioningLayer = issuerLayer.pipe(
  Layer.provideMerge(secretStoreLayer),
  Layer.provideMerge(directoryLayer),
  Layer.provideMerge(settingsLayer),
  Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))
);
