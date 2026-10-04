import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path } from "effect";

import { execute, FenceError, loadInstance } from "./scan.ts";

const program = Effect.gen(function* redTest() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(".");
  const instance = yield* loadInstance({ generic: false });

  if (instance === null) {
    return yield* new FenceError({ reason: "Private instance unavailable." });
  }

  const realHost = instance.hosts.find((value) => value.includes("."));

  if (realHost === undefined) {
    return yield* new FenceError({
      reason: "No real hostname available for the red test.",
    });
  }

  const directory = yield* fs.makeTempDirectoryScoped({
    directory: root,
    prefix: ".fence-red-",
  });

  const candidate = path.join(directory, "candidate.txt");

  const payload = [
    ["node-a", "network", "ts", "net"].join("."),
    [100, 75, 0, 1].join("."),
    realHost,
    ["", "Users", "joel", ""].join("/"),
  ].join("\n");

  yield* fs.writeFileString(candidate, payload);

  if (!(yield* fs.readFileString(candidate)).includes(realHost)) {
    return yield* new FenceError({
      reason: "Real hostname fixture was not written.",
    });
  }

  const relative = path.relative(root, candidate);

  yield* Effect.acquireRelease(
    execute({
      args: ["add", "--", relative],
      cwd: root,
      executable: "git",
    }).pipe(
      Effect.flatMap(({ code }) =>
        code === 0
          ? Effect.void
          : Effect.fail(
              new FenceError({ reason: "Could not stage the red fixture." })
            )
      )
    ),
    () =>
      execute({
        args: ["rm", "--cached", "-f", "--", relative],
        cwd: root,
        executable: "git",
      }).pipe(
        Effect.flatMap(({ code }) =>
          code === 0
            ? Effect.void
            : Effect.die("Could not unstage the owned red fixture.")
        ),
        Effect.orDie
      )
  );

  const result = yield* execute({
    args: [],
    cwd: root,
    executable: path.join(root, ".git", "hooks", "pre-commit"),
  });

  const output = new TextDecoder().decode(
    Buffer.concat([result.bytes, result.stderrBytes])
  );

  yield* fs.writeFileString(
    path.join(root, ".fence-tmp", "red-hook.log"),
    output
  );

  if (
    result.code === 0 ||
    !["tailnet-domain", "private-ip", "instance-hosts", "home-path"].every(
      (rule) => output.includes(rule)
    )
  ) {
    return yield* new FenceError({
      reason:
        "Installed pre-commit did not prove all required staged red rules.",
    });
  }

  yield* fs.writeFileString(
    candidate,
    "Clean working copy; the scanner must still inspect staged content.\n"
  );

  const staged = yield* execute({
    args: ["tools/fence/cli.ts", "--mode", "staged"],
    cwd: root,
    executable: "node",
  });

  const stagedOutput = new TextDecoder().decode(
    Buffer.concat([staged.bytes, staged.stderrBytes])
  );

  if (
    staged.code === 0 ||
    !["tailnet-domain", "private-ip", "instance-hosts", "home-path"].every(
      (rule) => stagedOutput.includes(rule)
    )
  ) {
    return yield* new FenceError({
      reason:
        "The scanner failed to inspect staged bytes independently of the working copy.",
    });
  }

  return yield* Console.log(
    "Red test passed: installed pre-commit rejected fake host, private IP, real instance hostname and home path. Separate index test rejected the same staged bytes despite a clean working copy. Fixture cleanup is scoped."
  );
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: () =>
        Console.error(
          "Red test failed; values redacted. Inspect the owned hook log."
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            })
          )
        ),
      onSuccess: () => Effect.void,
    }),
    Effect.provide(NodeServices.layer)
  )
);
