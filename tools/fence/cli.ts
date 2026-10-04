import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { scan } from "./scan.ts";

const failure = (reason: string) =>
  Console.error(reason).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      })
    )
  );

const command = Command.make(
  "fence",
  {
    generic: Flag.Boolean("generic").pipe(Flag.withDefault(false)),
    mode: Flag.Literals("mode", ["staged", "tree", "history"]),
    root: Flag.String("root").pipe(Flag.withDefault(".")),
  },
  Effect.fn("fence.command")(function* command({ mode, generic, root }) {
    const result = yield* scan({ generic, mode, root }).pipe(
      Effect.tap(({ count }) =>
        Console.log(
          `Fence passed: ${count} blobs; ${generic ? "generic rules only" : "private instance and generic rules"}.`
        )
      ),
      Effect.catchTag("FenceError", (error) => failure(error.reason)),
      Effect.catch(() =>
        failure(
          "Fence failed closed: instance, Git, filesystem or gitleaks unavailable or invalid. Values redacted."
        )
      )
    );

    return result;
  })
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer)
  )
);
