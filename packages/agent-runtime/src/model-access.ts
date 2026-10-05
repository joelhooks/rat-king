/* oxlint-disable typescript/promise-function-async -- Static auth is a pi-ai Promise callback. */
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { HarnessOptions, ModelRef } from "@earendil-works/pi-durable";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

import { ModelRefused } from "./model-refused.ts";

export { ModelRefused } from "./model-refused.ts";

export const AllowedModel = Schema.Literals([
  "gpt-6-sol",
  "gpt-6-luna",
  "claude-opus-5-5",
]);

export class ModelAccess extends Context.Service<
  ModelAccess,
  {
    readonly models: HarnessOptions["models"];
    readonly model: ModelRef;
  }
>()("@rat-king/ModelAccess") {}

export const modelGatewayLayer = () =>
  Layer.effect(
    ModelAccess,
    Effect.gen(function* configure() {
      const model = yield* Config.String("MODEL_GATEWAY_MODEL").pipe(
        Config.withDefault("gpt-6-sol")
      );

      const id = yield* Schema.decodeUnknownEffect(AllowedModel)(model).pipe(
        Effect.mapError(() => new ModelRefused({ model }))
      );

      const isOpus = id === "claude-opus-5-5";

      const options = yield* Config.unwrap({
        apiKey: Config.Redacted(
          isOpus ? "CLAUDE_SIDECAR_CREDENTIAL" : "MODEL_GATEWAY_CREDENTIAL"
        ),
        baseUrl: Config.String(
          isOpus ? "CLAUDE_SIDECAR_BASE_URL" : "MODEL_GATEWAY_BASE_URL"
        ),
      });

      if (isOpus) {
        const url = yield* Effect.try({
          catch: () => new ModelRefused({ model }),
          try: () => new URL(options.baseUrl),
        });

        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          url.port === "" ||
          url.username !== "" ||
          url.password !== "" ||
          url.search !== "" ||
          url.hash !== "" ||
          !/^\/v1\/?$/u.test(url.pathname)
        ) {
          return yield* new ModelRefused({ model });
        }
      }

      const provider = isOpus ? "claude-sidecar" : "model-gateway";
      const models = createModels();
      models.setProvider(
        createProvider({
          api: openAICompletionsApi(),
          auth: {
            apiKey: {
              name: isOpus ? "Sidecar bearer" : "Rat King client key",
              resolve: () =>
                Promise.resolve({
                  auth: {
                    apiKey: Redacted.value(options.apiKey),
                    headers: {
                      Authorization: `Bearer ${Redacted.value(options.apiKey)}`,
                    },
                  },
                }),
            },
          },
          baseUrl: options.baseUrl,
          id: provider,
          models: [
            {
              api: "openai-completions",
              baseUrl: options.baseUrl,
              compat: {
                supportsDeveloperRole: !isOpus,
                supportsReasoningEffort: !isOpus,
                supportsStore: false,
              },
              contextWindow: 32_768,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id,
              input: Array.of<"text">("text"),
              maxTokens: 1024,
              name: id,
              provider,
              reasoning: !isOpus,
            },
          ],
        })
      );

      return ModelAccess.of({ model: { modelId: id, provider }, models });
    })
  );
