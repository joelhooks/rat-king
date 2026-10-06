import { Config, Effect, FileSystem, Schema } from "effect";

import type { Node } from "../../packages/alchemy-nest/src/inventory-schema.ts";

export const stageName = Config.schema(
  Schema.Literals(["proof", "pilot", "fleet"]),
  "RAT_KING_STAGE"
).pipe(Config.withDefault("proof"));

export const workerIPv4 = (
  stage: "proof" | "pilot" | "fleet",
  node: Node
): string => (stage === "pilot" ? "127.0.0.1" : node.tailnetIPv4);

export const workerUrl = (
  stage: "proof" | "pilot" | "fleet",
  node: Node
): string => `http://${workerIPv4(stage, node)}:18787`;

export const configuration = Effect.fn("Nest.configuration")(
  function* configuration(node: Node) {
    const stage = yield* stageName;
    const pilot = stage === "pilot";
    const mailboxOnly = stage !== "proof";

    const mode = yield* Config.schema(
      Schema.Literals(["faux", "gateway"]),
      "RAT_KING_AGENT_MODEL"
    ).pipe(Config.withDefault("faux"));

    const sidecar = yield* Config.Boolean("RAT_KING_CLAUDE_SIDECAR").pipe(
      Config.withDefault(false)
    );

    const model = yield* Config.schema(
      Schema.Literals(["gpt-6-sol", "claude-opus-5-5"]),
      "MODEL_GATEWAY_MODEL"
    ).pipe(Config.withDefault("gpt-6-sol"));

    if (
      (model === "claude-opus-5-5" && !sidecar) ||
      (mode === "faux" && sidecar)
    ) {
      return yield* Effect.die("Unsupported hosted model configuration");
    }

    if (mailboxOnly && (mode !== "faux" || sidecar)) {
      return yield* Effect.die(
        "Mailbox-only stages refuse hosted models and sidecars"
      );
    }

    const memoryMax = yield* Config.String("RAT_KING_SLICE_MEMORY_MAX").pipe(
      Config.withDefault(pilot ? "1536M" : "4G")
    );

    if (stage === "fleet" && memoryMax !== "4G") {
      return yield* Effect.die("Fleet slice requires the approved 4G cap");
    }

    const fs = yield* FileSystem.FileSystem;

    return {
      cpuQuota: { fleet: "200%", pilot: "150%", proof: "300%" }[stage],
      gatewayUrl:
        mode === "gateway"
          ? yield* Config.String("MODEL_GATEWAY_BASE_URL")
          : "",
      hostedDid: mailboxOnly ? "" : yield* Config.String("RAT_KING_REMOTE_DID"),
      mailboxOnly,
      memoryMax,
      mode,
      model,
      pilot,
      remoteAgent: mailboxOnly
        ? ""
        : yield* Config.String("RAT_KING_REMOTE_AGENT"),
      secretName:
        mode === "gateway"
          ? yield* Config.String("RAT_KING_MODEL_GATEWAY_SECRET_NAME")
          : "",
      sidecar,
      sidecarBundle: sidecar
        ? yield* fs.readFileString(
            yield* Config.String("RAT_KING_SIDECAR_OUTPUT")
          )
        : "",
      workerIPv4: workerIPv4(stage, node),
      workerUrl: workerUrl(stage, node),
    };
  }
);
