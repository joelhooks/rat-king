import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { synchronizeInstructions } from "./ship-instruction-files.ts";

const command = Command.make(
  "ship-confidence",
  {
    root: Flag.String("root").pipe(Flag.withDefault(".")),
    write: Flag.Boolean("write").pipe(Flag.withDefault(false)),
  },
  Effect.fn("shipConfidenceCommand")(function* shipConfidence({ root, write }) {
    const path = yield* synchronizeInstructions(root, write);
    yield* Console.log(
      `Ship confidence ${write ? "rendered" : "matches"}: ${path}`
    );
  })
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer)
  )
);
