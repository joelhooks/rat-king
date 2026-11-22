import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Schema, Stdio, Stream } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  frontDeskCommand,
  readFrontDeskInput,
} from "../../../../stacks/nest/front-desk-command.ts";

it.effect.prop(
  "front desk stdin accepts exactly one bounded JSON payload with a quiet decision",
  [Schema.Boolean, Schema.Int],
  ([quiet, nonce]) =>
    Effect.gen(function* check() {
      const payload = {
        body: `body ${nonce} 🐀`,
        id: `${nonce}`,
        quiet,
        summary: "sample",
      };

      const bytes = new TextEncoder().encode(JSON.stringify(payload));

      expect(
        yield* readFrontDeskInput(
          Stream.make(bytes.slice(0, 12), bytes.slice(12))
        )
      ).toEqual(payload);

      expect(
        yield* readFrontDeskInput(
          Stream.make(bytes, new TextEncoder().encode(" ".repeat(65_536)))
        ).pipe(Effect.isFailure)
      ).toBe(true);
    })
);

it.effect("front desk times out a stalled stdin without a delivery", () =>
  Effect.gen(function* verify() {
    const child = yield* frontDeskCommand(["--stdin"]).pipe(
      Effect.provide([
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ RAT_KING_SECRET_SOURCE: "systemd" })
        ),
        Stdio.layerTest({ stdin: Stream.never }),
      ]),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected delivery"))
      ),
      Effect.flip,
      Effect.forkScoped
    );

    yield* TestClock.adjust("12 seconds");

    expect((yield* Fiber.join(child)).reason).toBe(
      "Front desk delivery not confirmed"
    );
  }).pipe(Effect.provide(NodeServices.layer))
);
