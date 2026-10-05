/* oxlint-disable typescript/promise-function-async -- Static auth is a pi-ai Promise callback. */
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
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
      const options = yield* Config.unwrap({
        apiKey: Config.Redacted("MODEL_GATEWAY_CREDENTIAL"),
        baseUrl: Config.String("MODEL_GATEWAY_BASE_URL"),
        model: Config.String("MODEL_GATEWAY_MODEL").pipe(
          Config.withDefault("gpt-6-sol")
        ),
      });

      const id = yield* Schema.decodeUnknownEffect(AllowedModel)(
        options.model
      ).pipe(Effect.mapError(() => new ModelRefused({ model: options.model })));

      const models = createModels();

      const provider = {
        auth: {
          apiKey: {
            name: "Rat King client key",
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
        id: "model-gateway",
      };

      const selected = {
        baseUrl: options.baseUrl,
        contextWindow: 32_768,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id,
        input: Array.of<"text">("text"),
        maxTokens: 1024,
        name: id,
        provider: "model-gateway",
        reasoning: true,
      };

      if (id === "claude-opus-5-5") {
        models.setProvider(
          createProvider({
            ...provider,
            api: anthropicMessagesApi(),
            baseUrl: options.baseUrl.replace(/\/v1\/?$/u, ""),
            models: [
              {
                ...selected,
                api: "anthropic-messages",
                baseUrl: options.baseUrl.replace(/\/v1\/?$/u, ""),
              },
            ],
          })
        );
      } else {
        models.setProvider(
          createProvider({
            ...provider,
            api: openAICompletionsApi(),
            models: [
              {
                ...selected,
                api: "openai-completions",
                compat: {
                  supportsDeveloperRole: true,
                  supportsReasoningEffort: true,
                  supportsStore: false,
                },
              },
            ],
          })
        );
      }

      return ModelAccess.of({
        model: { modelId: id, provider: "model-gateway" },
        models,
      });
    })
  );
