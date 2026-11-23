import { Config, Effect, Layer } from "effect";

import { offlineLayer } from "../../packages/alchemy-nest/src/fake-shell.ts";
import { HostShell } from "../../packages/alchemy-nest/src/host-shell.ts";
import {
  Host,
  layer as inventoryLayer,
} from "../../packages/alchemy-nest/src/host.ts";
import { layer as sshLayer } from "../../packages/alchemy-nest/src/ssh.ts";
import { guardedShell } from "./ship-restart.ts";

export const connection = Layer.unwrap(
  Effect.gen(function* connection() {
    const hosts = yield* Host;

    if (
      yield* Config.Boolean("RAT_KING_OFFLINE_PLAN").pipe(
        Config.withDefault(false)
      )
    ) {
      return offlineLayer;
    }

    const target = yield* hosts.node(
      yield* Config.String("RAT_KING_LIVE_NODE")
    );

    return Layer.effect(
      HostShell,
      Effect.gen(function* shipConnection() {
        return yield* guardedShell(yield* HostShell);
      })
    ).pipe(Layer.provide(sshLayer(target)));
  })
).pipe(Layer.provideMerge(inventoryLayer), Layer.orDie);
