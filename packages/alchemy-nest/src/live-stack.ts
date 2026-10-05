import { Stack, localState } from "alchemy";
import { Config, Effect, Layer } from "effect";

import { Celld } from "./celld.ts";
import { Host, layer as inventoryLayer } from "./host.ts";
import { ObjectStore } from "./object-store.ts";
import { sourceLayer } from "./release.ts";
import { layer as sshLayer } from "./ssh.ts";
import { startupLayer } from "./startup-contract.ts";

const host = inventoryLayer.pipe(Layer.orDie);

const shell = Layer.unwrap(
  Effect.gen(function* connection() {
    const inventory = yield* Host;

    return sshLayer(
      yield* inventory.node(yield* Config.String("RAT_KING_LIVE_NODE"))
    ).pipe(Layer.orDie);
  })
).pipe(Layer.provideMerge(host), Layer.orDie);

const startup = Layer.unwrap(
  Effect.gen(function* guards() {
    const inventory = yield* Host;

    const node = yield* inventory.node(
      yield* Config.String("RAT_KING_LIVE_NODE")
    );

    return startupLayer(node.tailnetIPv4);
  })
).pipe(Layer.provide(host), Layer.provide(shell), Layer.orDie);

export const liveStack = Stack(
  "rat-king-store-node",
  {
    providers: Layer.mergeAll(ObjectStore.providers(), Celld.providers()).pipe(
      Layer.provide(startup),
      Layer.provide(shell),
      Layer.provide(sourceLayer.pipe(Layer.orDie))
    ),
    state: localState(),
  },
  Effect.gen(function* program() {
    const inventory = yield* Host;

    const node = yield* inventory
      .node(yield* Config.String("RAT_KING_LIVE_NODE"))
      .pipe(Effect.orDie);

    const slice = yield* ObjectStore.Slice(node.home);

    const bucket = yield* ObjectStore.Bucket("store", {
      host: node,
      name: yield* Config.String("RAT_KING_BUCKET").pipe(
        Config.withDefault("rat-king-cells")
      ),
      purgeOnDelete: true,
      slice: slice.sha256,
    });

    const cells = yield* Celld.Node("celld", {
      bucket,
      host: node,
      purgeOnDelete: true,
    });

    return {
      bucket: bucket.resource.name,
      internalUrl: cells.internalUrl,
      publicUrl: cells.publicUrl,
      unit: cells.unit.sha256,
      version: cells.version,
    };
  }).pipe(Effect.provide(host))
);
