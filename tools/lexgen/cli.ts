import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { generate, GenerationError } from "./generate.ts";

const command = Command.make(
  "lexgen",
  {
    check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
    root: Flag.String("root").pipe(Flag.withDefault(".")),
    write: Flag.Boolean("write").pipe(Flag.withDefault(false)),
  },
  Effect.fn("lexgen.command")(function* command({ write, check, root }) {
    if (write === check) {
      return yield* new GenerationError({
        reason: "Choose exactly one of --write and --check",
      });
    }

    const result = yield* generate({ root, write });

    return yield* Console.log(
      `Lexgen ${write ? "wrote" : "checked"} ${result.files} files from ${result.documents} documents.`
    );
  })
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer)
  )
);
