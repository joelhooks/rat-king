import { NodeServices } from "@effect/platform-node";
import { adopt } from "alchemy/AdoptPolicy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { localState } from "alchemy/State/LocalState";
import { Config, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { provision } from "../../apps/mailbox/cli/provision.ts";
import { Documents } from "../../apps/mailbox/src/auth.ts";
import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { HostShell, must } from "../../packages/alchemy-nest/src/host-shell.ts";
import { Host } from "../../packages/alchemy-nest/src/host.ts";
import { listenerProbe } from "../../packages/alchemy-nest/src/probes.ts";
import { connection, nest } from "./stack.ts";

export type Action = "prepare" | "plan" | "deploy" | "listeners";

export const run = (action: Action) =>
  Effect.gen(function* runNestAction() {
    if (action === "prepare") {
      const fs = yield* FileSystem.FileSystem;
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      if ((yield* must(shell, ["uname", "-m"])).trim() !== "x86_64") {
        return yield* refuse("Wrong deployment architecture");
      }

      const cliPath = `${host.home}/.local/share/rat-king/bin/mailbox.mjs`;
      yield* shell.write({
        bytes: yield* fs.readFile(yield* Config.String("RAT_KING_CLI_OUTPUT")),
        mode: 0o600,
        path: cliPath,
      });

      const remote = yield* must(shell, [
        "node",
        cliPath,
        "identity",
        "--as",
        yield* Config.String("RAT_KING_REMOTE_AGENT"),
        "--did",
        yield* Config.String("RAT_KING_REMOTE_DID"),
      ]);

      const local = yield* provision(
        yield* Config.String("HOME"),
        yield* Config.String("RAT_KING_LOCAL_AGENT"),
        yield* Config.String("RAT_KING_LOCAL_DID")
      );

      const remoteDocuments = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Documents)
      )(`[${remote}]`);

      const documents = yield* Schema.decodeUnknownEffect(Documents)([
        local,
        ...remoteDocuments,
      ]);

      yield* fs.writeFileString(
        yield* Config.String("RAT_KING_DOCUMENTS"),
        JSON.stringify(documents),
        { mode: 0o600 }
      );
      yield* Effect.log("PROOF_IDENTITIES_READY");

      return yield* Effect.void;
    }

    if (action === "listeners") {
      const shell = yield* HostShell;
      const hosts = yield* Host;

      const host = yield* hosts.node(
        yield* Config.String("RAT_KING_LIVE_NODE")
      );

      yield* Effect.log(yield* listenerProbe(shell, host.tailnetIPv4, true));

      return yield* Effect.void;
    }

    if (action === "plan") {
      const plan = yield* evalStack(nest, (stack) => Plan.make(stack), {
        stage: "proof",
      }).pipe(adopt(true));

      const summary = Plan.describePlan(plan);

      const actions = Object.values(summary.resources).map(
        (resource) => resource.action
      );

      if (actions.some((entry) => entry === "delete" || entry === "replace")) {
        return yield* refuse("POC plan refuses delete or replace");
      }

      yield* Effect.log(
        JSON.stringify({
          actions,
          noop: actions.every((entry) => entry === "noop"),
        })
      );

      return yield* Effect.void;
    }

    if (!(yield* Config.Boolean("RAT_KING_START_APPROVED"))) {
      return yield* refuse("Host listener approval required");
    }

    yield* deploy({ stack: nest, stage: "proof" }).pipe(adopt(true));
    yield* Effect.log("MAILBOX_DEPLOYED");

    return yield* Effect.void;
  }).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        connection.pipe(Layer.provide(NodeServices.layer)),
        Layer.mergeAll(
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        ).pipe(Layer.provide(NodeServices.layer))
      )
    )
  );
