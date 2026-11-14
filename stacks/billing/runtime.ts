// @effect-diagnostics globalFetch:off -- The sole operator transport is explicitly selected at the composition root.
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import { evalStack } from "alchemy/EvalStack";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { localState } from "alchemy/State/LocalState";
import { Config, ConfigProvider, Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { refuse } from "../../packages/alchemy-nest/src/files.ts";
import { billingStack } from "./stack.ts";

export type Action = "plan" | "deploy" | "destroy-plan" | "destroy";

// oxlint-disable-next-line typescript/promise-function-async -- Offline transport rejects without I/O.
export const offlineFetch: typeof fetch = () =>
  Promise.reject(new Error("OFFLINE_HTTP_REFUSED"));

export const run = (action: Action, offline: boolean) =>
  Effect.gen(function* runBilling() {
    const stack = billingStack(offline);

    if (action === "deploy") {
      yield* deploy({ stack, stage: "pilot" });

      return yield* Effect.void;
    }

    if (action === "destroy") {
      yield* destroy({ stack, stage: "pilot" });

      return yield* Effect.void;
    }

    const plan =
      action === "plan"
        ? yield* evalStack(stack, (compiled) => Plan.make(compiled), {
            stage: "pilot",
          })
        : yield* evalStack(stack, (compiled) => Plan.destroy(compiled), {
            stage: "pilot",
          });

    const description = Plan.describePlan(plan);

    if (
      action === "plan" &&
      Object.values(description.resources).some(
        ({ action: planned }) => planned === "delete" || planned === "replace"
      )
    ) {
      return yield* refuse("Billing plan refuses delete or replace");
    }

    yield* Console.log(
      JSON.stringify(
        {
          mode: offline
            ? "offline-empty-state-assumption-NOT-live-reconciliation"
            : "live-read-plan",
          plan: description,
          surface: {
            durableObjects: [{ binding: "ALERTS", className: "BillingQueue" }],
            hostname: yield* Config.String("RAT_KING_BILLING_HOSTNAME"),
            paths: ["POST /", "GET /pull", "POST /ack"],
            rateLimit: {
              binding: "RATE_LIMIT",
              limit: 10,
              namespaceId: 1001,
              period: 60,
            },
            secrets: [
              {
                name: "BILLING_WEBHOOK_CREDENTIAL",
                type: "secret_text",
                value: "[REDACTED]",
              },
              {
                name: "BILLING_PULL_CREDENTIAL",
                type: "secret_text",
                value: "[REDACTED]",
              },
            ],
            workersDev: false,
          },
        },
        null,
        2
      )
    );

    return yield* Effect.void;
  }).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, AuthProvidersLive),
        FetchHttpClient.layer,
        Layer.mergeAll(
          AlchemyContextLive,
          localState(),
          layerNonInteractive()
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              AuthProvidersLive
            )
          )
        )
      )
    ),
    Effect.provideService(
      FetchHttpClient.Fetch,
      offline ? offlineFetch : fetch
    ),
    Effect.provide(
      offline
        ? ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({
              BILLING_PULL_CREDENTIAL: "offline-unset",
              BILLING_WEBHOOK_CREDENTIAL: "offline-unset",
            }),
            { asPrimary: true }
          )
        : Layer.empty
    )
  );
