// @effect-diagnostics asyncFunction:off -- The registration adapter exposes Pi's Promise API.
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { ratkingExtension } from "../src/extension.ts";

const ToolCopy = Schema.Struct({
  description: Schema.String,
  parameters: Schema.Struct({
    properties: Schema.Struct({
      summary: Schema.Struct({ description: Schema.String }),
    }),
  }),
});

it.effect(
  "registers human subject guidance on the tool and its summary field",
  () =>
    Effect.gen(function* summaryGuidance() {
      const registered: unknown[] = [];

      yield* Effect.promise(async () => {
        await ratkingExtension({
          facts: () => Effect.die("Registration must not start a reader"),
          layer: Layer.effectContext(
            Effect.die("Registration does not build services")
          ),
          tool: Effect.succeed("ratking"),
        })({
          events: createEventBus(),
          onSessionEnd: () => {},
          onSessionStart: () => {},
          registerMessageRenderer: () => {},
          registerTool: (definition) => {
            registered.push(definition);
          },
          sendMessage: () => {},
        });
      });

      const guidance =
        /lead with the point or the ask\.[\s\S]*Write the summary as a subject line that tells someone scanning the list what the message is about\. Leave out IDs, hashes and the recipient's name\./iu;

      const [tool] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([ToolCopy])
      )(registered);

      expect(tool.description).toMatch(guidance);
      expect(tool.parameters.properties.summary.description).toMatch(guidance);
    })
);
