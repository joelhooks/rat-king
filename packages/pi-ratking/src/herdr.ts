import { Effect, Option, Schema } from "effect";

import { runCommand } from "./process.ts";

const PaneInfo = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ label: Schema.String }) }),
});

export const paneLabel = Effect.fn("RatKing.paneLabel")(
  function* paneLabel(paneId: string) {
    const result = yield* runCommand(["herdr", "pane", "get", paneId]);

    if (result.code !== 0) {
      return Option.none();
    }

    const info = yield* Schema.decodeEffect(Schema.fromJsonString(PaneInfo))(
      result.stdout
    );

    return Option.some(info.result.pane.label);
  },
  Effect.orElseSucceed(Option.none<string>)
);
