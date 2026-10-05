import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { expect, vi } from "vitest";

import {
  modelGatewayLayer,
  ModelAccess,
  ModelRefused,
} from "../src/model-access.ts";

it.effect("refuses Sonnet and Fable before any fetch", () =>
  Effect.gen(function* refusal() {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    try {
      for (const model of ["claude-sonnet-5", "claude-fable-5-1"]) {
        const failure = yield* Effect.flip(
          Effect.service(ModelAccess).pipe(
            Effect.provide(
              modelGatewayLayer().pipe(
                Layer.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({
                      MODEL_GATEWAY_BASE_URL:
                        "https://models.example.invalid/v1",
                      MODEL_GATEWAY_CREDENTIAL: "example-key",
                      MODEL_GATEWAY_MODEL: model,
                    })
                  )
                )
              )
            )
          )
        );

        expect(failure).toBeInstanceOf(ModelRefused);
        expect(failure).toMatchObject({ model });
      }

      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  })
);
