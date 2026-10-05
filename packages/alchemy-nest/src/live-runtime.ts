import { NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { localState } from "alchemy/State/LocalState";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { refuse } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import { Host, layer as inventoryLayer } from "./host.ts";
import { liveStack } from "./live-stack.ts";
import {
  bootstrapProbe,
  bootstrapCheck,
  diagnoseProbe,
  listenerProbe,
  raceProbe,
} from "./probes.ts";
import { layer as sshLayer } from "./ssh.ts";

export type LiveAction =
  | "deploy"
  | "plan"
  | "diagnose"
  | "race"
  | "listeners"
  | "health"
  | "bootstrap"
  | "preflight"
  | "store-listeners"
  | "status"
  | "uid-probe"
  | "bootstrap-check";

const connection = Layer.unwrap(
  Effect.gen(function* connect() {
    const inventory = yield* Host;

    return sshLayer(
      yield* inventory.node(yield* Config.String("RAT_KING_LIVE_NODE"))
    );
  })
).pipe(Layer.provideMerge(inventoryLayer));

export const run = (action: LiveAction) =>
  Effect.gen(function* live() {
    yield* Config.String("RAT_KING_LIVE_NODE");

    if (action === "deploy") {
      const approved = yield* Config.Boolean("RAT_KING_START_APPROVED").pipe(
        Config.withDefault(false)
      );

      if (!approved) {
        return yield* refuse(
          "Service starts need the owner's host gate first."
        );
      }

      yield* deploy({ stack: liveStack, stage: "proof" });
      yield* Effect.log("DEPLOYED");

      return yield* Effect.void;
    }

    if (action === "plan") {
      const plan = yield* evalStack(liveStack, (stack) => Plan.make(stack), {
        stage: "proof",
      });

      const summary = Plan.describePlan(plan);

      const actions = Object.values(summary.resources).map(
        (resource) => resource.action
      );

      yield* Effect.log(
        JSON.stringify({
          actions,
          noop: actions.every((entry) => entry === "noop"),
        })
      );

      return yield* Effect.void;
    }

    const probe = Effect.gen(function* probe() {
      const shell = yield* HostShell;
      const inventory = yield* Host;

      const host = yield* inventory.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      if (action === "preflight") {
        const arch = yield* must(shell, ["uname", "-m"]);

        if (arch.trim() !== "x86_64") {
          return yield* refuse("Pinned assets require Linux x86_64.");
        }

        yield* must(shell, ["python3", "--version"]);
        yield* Effect.log(
          JSON.stringify({
            binaryParentExists:
              (yield* shell.stat(`${host.home}/.local/share`))?.kind ===
              "directory",
            configParentExists:
              (yield* shell.stat(`${host.home}/.config`))?.kind === "directory",
            dataParentExists:
              (yield* shell.stat(
                host.dataRoot.slice(0, host.dataRoot.lastIndexOf("/"))
              ))?.kind === "directory",
            dataRootExists:
              (yield* shell.stat(host.dataRoot))?.kind === "directory",
          })
        );
      }

      if (action === "bootstrap") {
        yield* Effect.log(yield* bootstrapProbe(shell, host));
      }

      if (action === "diagnose") {
        yield* Effect.log(yield* diagnoseProbe(shell, host));
      }

      if (action === "race") {
        const approved = yield* Config.Boolean("RAT_KING_RACE_APPROVED").pipe(
          Config.withDefault(false)
        );

        if (!approved) {
          return yield* refuse(
            "Race burst needs the owner's time window first."
          );
        }

        yield* Effect.log(
          JSON.stringify(
            yield* raceProbe(shell, {
              config: `${host.home}/.config/rat-king/s3.json`,
              endpoint: "http://127.0.0.1:18333",
              name: yield* Config.String("RAT_KING_BUCKET").pipe(
                Config.withDefault("rat-king-cells")
              ),
            })
          )
        );
      }

      if (action === "store-listeners") {
        yield* Effect.log(yield* listenerProbe(shell, host.tailnetIPv4, false));
      }

      if (action === "status") {
        for (const name of [
          "rat-king.slice",
          "rat-king-seaweedfs.service",
          "rat-king-celld.service",
        ]) {
          yield* Effect.log(
            name,
            yield* must(shell, [
              "systemctl",
              "--user",
              "show",
              name,
              "--property=Type,ActiveState,NRestarts,Slice,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TasksMax,Nice",
            ])
          );
        }
      }

      if (action === "uid-probe") {
        const result = yield* must(shell, [
          "python3",
          "-c",
          'import socket,json; ports=[19333,18081,18888,18333,29333,28081,28888,28333,18788]; [socket.create_connection(("127.0.0.1", port), timeout=3).close() for port in ports]; print(json.dumps({"connected":ports}))',
        ]);

        yield* Effect.log(result);
      }

      if (action === "bootstrap-check") {
        yield* Effect.log(
          yield* bootstrapCheck(`http://${host.tailnetIPv4}:18787/`)
        );
      }

      if (action === "listeners") {
        yield* Effect.log(yield* listenerProbe(shell, host.tailnetIPv4, true));
      }

      if (action === "health") {
        const client = yield* HttpClient.HttpClient;

        const response = yield* client.get(
          `http://${host.tailnetIPv4}:18787/.well-known/celld/health`
        );

        if (response.status !== 200) {
          return yield* refuse(`Node health returned ${response.status}.`);
        }

        yield* Effect.log("health 200");
      }

      return yield* Effect.void;
    }).pipe(Effect.provide(Layer.mergeAll(connection, FetchHttpClient.layer)));

    return yield* probe;
  }).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        Layer.mergeAll(
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        ).pipe(Layer.provide(NodeServices.layer))
      )
    )
  );
