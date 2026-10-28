import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { expect } from "vitest";

import { configuration } from "../../../stacks/nest/config.ts";

it.effect("the fleet slice defaults to 14G when no cap is configured", () =>
  Effect.gen(function* fleetDefault() {
    const config = yield* configuration({
      dataRoot: "/srv/example",
      home: "/home/example",
      ssh: "example.invalid",
      tailnetIPv4: "203.0.113.10",
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            RAT_KING_AGENT_MODEL: "faux",
            RAT_KING_CLAUDE_SIDECAR: "false",
            RAT_KING_STAGE: "fleet",
          })
        )
      )
    );

    expect(config.memoryMax).toBe("14G");
  }).pipe(Effect.provide(NodeServices.layer))
);
