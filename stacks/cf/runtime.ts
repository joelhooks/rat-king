import { NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import * as Cloudflare from "alchemy/Cloudflare";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { localState } from "alchemy/State/LocalState";
import { Config, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { workerName } from "./projection.ts";
import { preview } from "./stack.ts";
import { teardownProbe } from "./teardown.ts";

export type Action =
  | "plan"
  | "deploy"
  | "destroy-plan"
  | "destroy"
  | "teardown-probe";

// oxlint-disable-next-line typescript/promise-function-async -- A rejecting transport never performs I/O.
export const offlineFetch: typeof fetch = () =>
  Promise.reject(new Error("OFFLINE_HTTP_REFUSED"));

export const run = (action: Action, offline: boolean) =>
  Effect.gen(function* runPreview() {
    if (action === "teardown-probe") {
      const labels = yield* Effect.gen(function* authenticatedProbe() {
        const credentials = yield* yield* Cloudflare.Credentials;

        if (credentials.type !== "apiToken") {
          return yield* refuse(
            "Teardown requires Alchemy API-token credentials"
          );
        }

        return yield* teardownProbe(
          yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
          workerName,
          Redacted.value(credentials.apiToken),
          fetch
        );
      }).pipe(
        Effect.provide(
          Cloudflare.CloudflareApiLive().pipe(
            Layer.provide(Layer.succeed(AuthProviders, {}))
          )
        ),
        Effect.catchCause(() =>
          Effect.succeed(["WORKER_ABSENT_FAIL", "NAMESPACES_ABSENT_FAIL"])
        )
      );

      for (const label of labels) {
        yield* Effect.log(label);
      }

      if (labels.some((label) => label.endsWith("_FAIL"))) {
        return yield* refuse("Teardown probe failed");
      }

      return yield* Effect.void;
    }

    if (action === "deploy") {
      yield* deploy({ stack: preview, stage: "preview" });
      yield* Effect.log("PREVIEW_DEPLOYED");

      return yield* Effect.void;
    }

    if (action === "destroy") {
      yield* destroy({ stack: preview, stage: "preview" });
      yield* Effect.log("PREVIEW_DESTROYED");

      return yield* Effect.void;
    }

    const plan = yield* evalStack(
      preview,
      (stack) =>
        Effect.gen(function* previewPlan() {
          yield* Effect.log(
            JSON.stringify({
              graph: Object.values(stack.resources).map((resource) => ({
                id: resource.LogicalId,
                type: resource.Type,
              })),
              stage: stack.stage,
            })
          );

          return yield* action === "destroy-plan"
            ? Plan.destroy(stack)
            : Plan.make(stack);
        }),
      { stage: "preview" }
    );

    const summary = Plan.describePlan(plan);

    const actions = Object.values(summary.resources).map(
      (resource) => resource.action
    );

    if (
      action === "plan" &&
      actions.some((entry) => entry === "delete" || entry === "replace")
    ) {
      return yield* refuse("POC plan refuses delete or replace");
    }

    yield* Effect.log(
      JSON.stringify({ actions, resources: Object.keys(summary.resources) })
    );

    return yield* Effect.void;
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
    ),
    Effect.provideService(FetchHttpClient.Fetch, offline ? offlineFetch : fetch)
  );
